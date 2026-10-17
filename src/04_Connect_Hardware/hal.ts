// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the universal hardware abstraction layer: one bus that discovers, pairs,
 * labels and feeds every optional device the city can talk to — DualSense / DualSense Edge over WebHID
 * (brake-trigger resistance and rumble), HAL/1 line-protocol gadgets over Web Serial or Bluetooth LE
 * (telemetry), and Gamepad API pads (rumble) — behind one transport-neutral API. Every browser API it
 * touches is optional: where WebHID, Web Serial or Web Bluetooth are missing (Safari, Firefox, iOS) it
 * reports them unsupported and does nothing, silently.
 * What breaks if it is removed? Input.hal, the Ring-0 terminal's `hal` command and the HUD device line.
 */
import { BRAND } from '../brand.ts'
import { DUALSENSE_FILTERS, DualSense, dualSenseName, isDualSense } from './dualsense.ts'
import { genericLayoutOf, padName, parsePadId } from './gamepad.ts'
import { LineLink, NUS, openBle, openSerial, type ByteChannel } from './lineLink.ts'
import type { BleDevice, GamepadLike, HardwareNavigator, HidConnectionEvent, HidDevice, SerialConnectionEvent, SerialPort } from './web-hardware.d.ts'

export type Transport = 'hid' | 'serial' | 'bluetooth' | 'gamepad'

export interface HalDevice {
  id: string
  transport: Transport
  name: string
  state: 'handshaking' | 'ready' | 'error' | 'disconnected'
  detail: string
}

export interface HalOutputs {
  /** 0..1, brake-trigger resistance. */
  triggerResistance: number
  /** 0..1 */
  rumble: number
}

export interface HalOptions {
  /** Defaults to globalThis.navigator; null disables every transport. */
  navigator?: HardwareNavigator | null
  brand?: { name: string; version: string }
  now?: () => number
  /** Minimum spacing of DualSense output reports, ms. */
  hidIntervalMs?: number
  /** Bluetooth connect + service discovery budget, ms. */
  bleConnectMs?: number
}

interface Entry {
  dev: HalDevice
  key: unknown
  ds?: DualSense
  link?: LineLink
}

interface PadSlot {
  dev: HalDevice
  index: number
  id: string
  vendor: number
  product: number
  pad: GamepadLike
  frame: number
  /** Frame in which this pad was hidden as the browser's mirror of a HID-decoded controller. */
  hidden: number
  rumble: number
  rumbleAt: number
}

/** Gamepad rumble is a timed effect: re-issued while held so it never lapses between frames. */
const PAD_RUMBLE = { durationMs: 250, refreshMs: 150, minGapMs: 50, steps: 16 } as const
const TELEMETRY_MS = 100
const LABEL: Readonly<Record<'hid' | 'serial' | 'bluetooth', string>> = { hid: 'WebHID', serial: 'Web Serial', bluetooth: 'Web Bluetooth' }

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0)
const hex4 = (n: number) => n.toString(16).padStart(4, '0')
const errorName = (e: unknown) => (typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '')
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** Reads live state (TypeScript would otherwise keep a pre-await narrowing). */
const gone = (e: { dev: HalDevice }) => e.dev.state === 'disconnected'
/** The hardware list's word on a pad without the standard mapping: how gamepad.ts GenericPads reads it, if at all. */
function genericDetail(p: GamepadLike): string {
  if (p.axes.length < 2 || p.buttons.length < 4) return 'non-standard mapping (ignored: no stick)'
  const layout = genericLayoutOf(p)
  if (layout === 'evdev') return 'non-standard mapping (read in Linux order: sticks, triggers, d-pad)'
  return layout === 'four-axis' ? 'non-standard mapping (best guess: two sticks, face buttons)' : 'non-standard mapping (best guess: left stick, face buttons)'
}
const copy = (d: HalDevice): HalDevice => ({ id: d.id, transport: d.transport, name: d.name, state: d.state, detail: d.detail })

function defaultNavigator(): HardwareNavigator | null {
  const g = globalThis as { navigator?: HardwareNavigator }
  return g.navigator ?? null
}

const guard = (f: () => void) => { try { f() } catch { /* API present but blocked */ } }

/** Runs a browser call that may throw synchronously (permissions policy) or reject; never fails. */
function quietly(f: () => Promise<unknown>): Promise<void> {
  try { return f().then(() => {}, () => {}) } catch { return Promise.resolve() }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e: unknown) => { clearTimeout(t); reject(e) })
  })
}

type DomLike = { addEventListener?(t: string, f: () => void): void; removeEventListener?(t: string, f: () => void): void; visibilityState?: string }

export class HalBus {
  private readonly nav: HardwareNavigator | null
  private readonly brand: { name: string; version: string }
  private readonly now: () => number
  private readonly hidInterval: number
  private readonly bleConnectMs: number
  private readonly entries: Entry[] = []
  private readonly slots: PadSlot[] = []
  private readonly padList: GamepadLike[] = []
  private readonly want: HalOutputs = { triggerResistance: 0, rumble: 0 }
  private readonly unlisten: (() => void)[] = []
  private listening = false
  private disposed = false
  private hidden = false
  private frame = 0
  private serialNo = 0
  private lastTelemetry = -1e9

  constructor(opts: HalOptions = {}) {
    this.nav = opts.navigator === undefined ? defaultNavigator() : opts.navigator
    this.brand = opts.brand ?? { name: BRAND.name, version: BRAND.version }
    this.now = opts.now ?? (() => performance.now())
    this.hidInterval = opts.hidIntervalMs ?? 25
    this.bleConnectMs = opts.bleConnectMs ?? 10000
  }

  support(): Record<Transport, boolean> {
    const n = this.nav
    return {
      hid: !!n?.hid,
      serial: !!n?.serial,
      bluetooth: !!n?.bluetooth,
      gamepad: typeof n?.getGamepads === 'function',
    }
  }

  /** Re-opens devices this origin was granted before, and follows plug/unplug events. Never prompts. */
  async autoconnect(): Promise<void> {
    const n = this.nav
    if (!n || this.disposed) return
    this.listen()
    const hid = n.hid, serial = n.serial, ble = n.bluetooth
    await Promise.all([
      hid && quietly(() => hid.getDevices().then((list) => Promise.all(list.filter((d) => isDualSense(d.vendorId, d.productId)).map((d) => this.openHid(d))))),
      serial && quietly(() => serial.getPorts().then((list) => Promise.all(list.map((p) => this.openSerialPort(p))))),
      ble?.getDevices && quietly(() => ble.getDevices!().then((list) => Promise.all(list.map((d) => this.openBleDevice(d, true))))),
    ])
  }

  /**
   * Shows the browser's device chooser. It is requested synchronously, so call this directly inside a click or
   * key handler (the browser demands a user gesture). Resolves null when the person cancels; an unsupported
   * transport or a refused request resolves a device in state 'error' whose detail says why (not listed).
   */
  pair(kind: 'hid' | 'serial' | 'bluetooth'): Promise<HalDevice | null> {
    const n = this.nav
    if (this.disposed) return Promise.resolve(null)
    const refused = (e: unknown): HalDevice | null => {
      const name = errorName(e)
      if (name === 'NotFoundError' || name === 'AbortError') return null
      return { id: `${kind}:request`, transport: kind, name: LABEL[kind], state: 'error', detail: errorText(e) }
    }
    try {
      if (kind === 'hid' && n?.hid) {
        const request = n.hid.requestDevice({ filters: DUALSENSE_FILTERS.map((f) => ({ vendorId: f.vendorId, productId: f.productId })) })
        this.listen()
        return request.then(async (list) => {
          const mine = list.filter((d) => isDualSense(d.vendorId, d.productId))
          if (!mine.length) return null
          const opened = await Promise.all(mine.map((d) => this.openHid(d)))
          return opened[0]
        }, refused)
      }
      if (kind === 'serial' && n?.serial) {
        const request = n.serial.requestPort()
        this.listen()
        return request.then((p) => this.openSerialPort(p), refused)
      }
      if (kind === 'bluetooth' && n?.bluetooth) {
        const request = n.bluetooth.requestDevice({ filters: [{ services: [NUS.service] }], optionalServices: [NUS.service] })
        this.listen()
        return request.then((d) => this.openBleDevice(d, false), refused)
      }
    } catch (e) {
      return Promise.resolve(refused(e))
    }
    return Promise.resolve({ id: `${kind}:request`, transport: kind, name: LABEL[kind], state: 'error', detail: `${LABEL[kind]} is not available in this browser` })
  }

  devices(): HalDevice[] {
    const out: HalDevice[] = []
    for (const e of this.entries) out.push(copy(e.dev))
    for (const s of this.slots) out.push(copy(s.dev))
    return out
  }

  /** Desired outputs. Cheap when nothing changed; drivers quantize, rate-limit and write change-only. */
  output(o: Partial<HalOutputs>): void {
    let changed = false
    if (o.triggerResistance !== undefined) {
      const v = clamp01(o.triggerResistance)
      if (v !== this.want.triggerResistance) { this.want.triggerResistance = v; changed = true }
    }
    if (o.rumble !== undefined) {
      const v = clamp01(o.rumble)
      if (v !== this.want.rumble) { this.want.rumble = v; changed = true }
    }
    if (changed && !this.hidden && !this.disposed) this.push()
  }

  /** At most 10 Hz, one JSON line to every ready line-protocol device. */
  telemetry(fields: Record<string, number | string | boolean>): void {
    const now = this.now()
    if (now - this.lastTelemetry < TELEMETRY_MS || this.disposed) return
    let line: string | null = null
    for (let i = 0; i < this.entries.length; i++) {
      const link = this.entries[i].link
      if (!link || link.state !== 'ready') continue
      if (line === null) {
        try { line = `${JSON.stringify(fields)}\n` } catch { return }
      }
      link.telemetry(line)
    }
    if (line !== null) this.lastTelemetry = now
  }

  /** One line for the HUD, e.g. "1 device · DualSense (USB) ready" ('' when nothing is attached). */
  summary(): string {
    let n = 0, head: HalDevice | null = null, rank = -1
    const consider = (d: HalDevice) => {
      if (d.state === 'disconnected') return
      n++
      const r = (d.state === 'ready' ? 4 : d.state === 'handshaking' ? 2 : 0) + (d.transport === 'gamepad' ? 0 : 1)
      if (r > rank) { rank = r; head = d }
    }
    for (const e of this.entries) consider(e.dev)
    for (const s of this.slots) consider(s.dev)
    if (!head) return ''
    const h: HalDevice = head
    return `${n} device${n === 1 ? '' : 's'} · ${h.name} ${h.state}${n > 1 ? ` +${n - 1}` : ''}`
  }

  /**
   * Per frame, from Input.poll: the pads to read — browser pads plus HID-decoded DualSense pads, minus a browser
   * pad whose controller the HID driver is already decoding. Also refreshes gamepad rumble. Reuses one array.
   */
  readPads(): readonly GamepadLike[] {
    const list = this.padList
    list.length = 0
    const n = this.nav
    let pads: ArrayLike<GamepadLike | null> | null = null
    if (n && typeof n.getGamepads === 'function' && !this.disposed) {
      try { pads = n.getGamepads() } catch { pads = null }
    }
    const frame = this.syncPads(pads)
    const now = this.now()
    for (let i = 0; i < this.entries.length; i++) {
      const ds = this.entries[i].ds
      if (!ds || !ds.inputLive(now)) continue
      list.push(ds.pad)
      this.hideMirror(ds, frame)
    }
    if (pads) {
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i]
        if (!p || !p.connected) continue
        const s = this.slotOf(p.index)
        if (s && s.hidden === frame) continue
        list.push(p)
      }
    }
    this.pumpPadRumble(now)
    return list
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const u of this.unlisten) guard(u)
    this.unlisten.length = 0
    for (const s of this.slots) this.stopPadRumble(s)
    const jobs: Promise<unknown>[] = []
    for (const e of this.entries) {
      if (e.ds) jobs.push(e.ds.close())
      if (e.link) jobs.push(e.link.close())
      e.dev.state = 'disconnected'
      e.dev.detail = 'closed'
    }
    await Promise.allSettled(jobs)
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────────

  private listen(): void {
    if (this.listening || this.disposed) return
    this.listening = true
    const n = this.nav
    if (n?.hid) {
      const hid = n.hid
      const onConnect = (e: HidConnectionEvent) => {
        if (isDualSense(e.device.vendorId, e.device.productId)) void this.openHid(e.device)
      }
      const onDisconnect = (e: HidConnectionEvent) => {
        const entry = this.find(e.device)
        if (entry) void this.drop(entry, 'unplugged')
      }
      guard(() => {
        hid.addEventListener('connect', onConnect)
        hid.addEventListener('disconnect', onDisconnect)
        this.unlisten.push(() => { hid.removeEventListener('connect', onConnect); hid.removeEventListener('disconnect', onDisconnect) })
      })
    }
    if (n?.serial) {
      const serial = n.serial
      const onConnect = (e: SerialConnectionEvent) => { if (e.target) void this.openSerialPort(e.target as SerialPort) }
      const onDisconnect = (e: SerialConnectionEvent) => {
        const entry = this.find(e.target)
        if (entry) void this.drop(entry, 'unplugged')
      }
      guard(() => {
        serial.addEventListener('connect', onConnect)
        serial.addEventListener('disconnect', onDisconnect)
        this.unlisten.push(() => { serial.removeEventListener('connect', onConnect); serial.removeEventListener('disconnect', onDisconnect) })
      })
    }
    // A stuck rumble or a stiff trigger must not outlive the visible page.
    const g = globalThis as { document?: DomLike } & DomLike
    const doc = g.document
    if (doc?.addEventListener) {
      // A page opened in a background tab starts hidden: nothing may stiffen a trigger before it is seen.
      this.hidden = doc.visibilityState === 'hidden'
      const onVisibility = () => this.setHidden(doc.visibilityState === 'hidden')
      guard(() => {
        doc.addEventListener!('visibilitychange', onVisibility)
        this.unlisten.push(() => doc.removeEventListener?.('visibilitychange', onVisibility))
      })
    }
    if (typeof g.addEventListener === 'function') {
      const onPageHide = () => { for (const e of this.entries) e.ds?.panic() }
      guard(() => {
        g.addEventListener!('pagehide', onPageHide)
        this.unlisten.push(() => g.removeEventListener?.('pagehide', onPageHide))
      })
    }
  }

  private setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return
    this.hidden = hidden
    if (hidden) {
      for (const e of this.entries) e.ds?.set(0, 0)
      for (const s of this.slots) this.stopPadRumble(s)
    } else this.push()
  }

  private push(): void {
    const t = this.want.triggerResistance, r = this.want.rumble
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]
      if (e.ds && e.dev.state !== 'disconnected') e.ds.set(t, r)
    }
    this.pumpPadRumble(this.now())
  }

  private find(key: unknown): Entry | undefined {
    for (const e of this.entries) if (e.key === key) return e
    return undefined
  }

  private add(key: unknown, transport: Transport, id: string, name: string): Entry {
    const e: Entry = { key, dev: { id, transport, name, state: 'handshaking', detail: 'opening' } }
    // A re-plugged device can come back as a new object: retire its stale disconnected row (same id stem).
    const stem = id.split('#')[0]
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const old = this.entries[i].dev
      if (old.state === 'disconnected' && old.id.split('#')[0] === stem) this.entries.splice(i, 1)
    }
    this.entries.push(e)
    return e
  }

  private async drop(e: Entry, reason: string): Promise<void> {
    e.dev.state = 'disconnected'
    e.dev.detail = reason
    const ds = e.ds, link = e.link
    e.ds = undefined
    e.link = undefined
    try {
      if (ds) await ds.close()
      if (link) await link.close()
    } catch { /* already gone */ }
    e.dev.detail = reason
  }

  /** What an open attempt after dispose() reports: nothing is opened, nothing is listed. */
  private closedRow(transport: Transport, name: string): HalDevice {
    return { id: `${transport}:closed`, transport, name, state: 'disconnected', detail: 'closed' }
  }

  private async openHid(device: HidDevice): Promise<HalDevice> {
    if (this.disposed) return this.closedRow('hid', dualSenseName(device.productId))
    let e = this.find(device)
    if (e && e.ds && e.dev.state !== 'error') return copy(e.dev)
    const name = dualSenseName(device.productId)
    if (!e) e = this.add(device, 'hid', `hid:${hex4(device.vendorId)}:${hex4(device.productId)}#${++this.serialNo}`, name)
    const entry = e
    // A driver whose writes failed is retired (listener off, device reset and closed) before a fresh one opens.
    const old = entry.ds
    entry.ds = undefined
    if (old) void old.close()
    entry.dev.state = 'handshaking'
    entry.dev.detail = 'opening'
    const ds = new DualSense(device, {
      now: this.now,
      minIntervalMs: this.hidInterval,
      padIndex: 16 + (this.serialNo & 7),
      onStatus: (err) => {
        if (entry.ds !== ds || entry.dev.state === 'disconnected') return
        entry.dev.state = err ? 'error' : 'ready'
        entry.dev.detail = err ? `write failed: ${err}` : ds.describe()
      },
    })
    entry.ds = ds
    try {
      await ds.open()
      if (this.disposed || entry.ds !== ds) { await ds.close(); return copy(entry.dev) }
      entry.dev.name = `${ds.name} (${ds.bus === 'usb' ? 'USB' : 'Bluetooth'})`
      entry.dev.state = 'ready'
      entry.dev.detail = ds.describe()
      if (!this.hidden) ds.set(this.want.triggerResistance, this.want.rumble)
    } catch (err) {
      if (entry.ds === ds) entry.ds = undefined
      void ds.close()
      if (!gone(entry)) {
        entry.dev.state = 'error'
        entry.dev.detail = errorText(err)
      }
    }
    return copy(entry.dev)
  }

  private async openSerialPort(port: SerialPort): Promise<HalDevice> {
    if (this.disposed) return this.closedRow('serial', 'Serial port')
    const known = this.find(port)
    if (known && known.link && (known.dev.state === 'ready' || known.dev.state === 'handshaking')) return copy(known.dev)
    let info: { usbVendorId?: number; usbProductId?: number } = {}
    try { info = port.getInfo() } catch { /* optional */ }
    const usb = info.usbVendorId !== undefined ? `${hex4(info.usbVendorId)}:${hex4(info.usbProductId ?? 0)}` : ''
    const label = usb ? `Serial ${usb}` : 'Serial port'
    const e = known ?? this.add(port, 'serial', `serial:${usb || 'port'}#${++this.serialNo}`, label)
    e.dev.state = 'handshaking'
    e.dev.detail = 'opening'
    let channel: ByteChannel
    try {
      channel = await openSerial(port)
    } catch (err) {
      e.dev.state = 'error'
      e.dev.detail = errorText(err)
      return copy(e.dev)
    }
    return this.handshake(e, channel)
  }

  private async openBleDevice(device: BleDevice, quiet: boolean): Promise<HalDevice> {
    if (this.disposed) return this.closedRow('bluetooth', device.name || 'BLE UART')
    const known = this.find(device.id)
    if (known && known.link && (known.dev.state === 'ready' || known.dev.state === 'handshaking')) return copy(known.dev)
    const e = known ?? this.add(device.id, 'bluetooth', `ble:${device.id}`, device.name || 'BLE UART')
    e.dev.state = 'handshaking'
    e.dev.detail = 'connecting'
    let channel: ByteChannel
    try {
      channel = await withTimeout(openBle(device), this.bleConnectMs, 'Bluetooth connect')
    } catch (err) {
      // A remembered device that is simply out of range is not an error.
      e.dev.state = quiet ? 'disconnected' : 'error'
      e.dev.detail = errorText(err)
      try { device.gatt?.disconnect() } catch { /* ignore */ }
      return copy(e.dev)
    }
    return this.handshake(e, channel)
  }

  private async handshake(e: Entry, channel: ByteChannel): Promise<HalDevice> {
    const sync = () => {
      const l = e.link
      if (!l) return
      e.dev.state = l.state
      e.dev.detail = l.detail
      if (l.name) e.dev.name = l.name
    }
    const link = new LineLink(channel, { brand: this.brand.name, version: this.brand.version, onChange: sync })
    e.link = link
    sync()
    if (this.disposed) { await link.close(); return copy(e.dev) }
    await link.start()
    sync()
    return copy(e.dev)
  }

  private slotOf(index: number): PadSlot | undefined {
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i].index === index) return this.slots[i]
    return undefined
  }

  /** Tracks connected browser pads by index; allocates only when a pad connects or disconnects. */
  private syncPads(pads: ArrayLike<GamepadLike | null> | null): number {
    const frame = ++this.frame
    let seen = 0
    if (pads) {
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i]
        if (!p || !p.connected) continue
        seen++
        const s = this.slotOf(p.index)
        if (s && s.id === p.id) { s.pad = p; s.frame = frame; continue }
        if (s) { this.stopPadRumble(s); this.slots.splice(this.slots.indexOf(s), 1) }
        const ids = parsePadId(p.id)
        const standard = p.mapping === 'standard'
        this.slots.push({
          dev: {
            id: `gamepad:${p.index}`, transport: 'gamepad', name: padName(p.id), state: 'ready',
            detail: standard ? `standard mapping${p.vibrationActuator?.playEffect ? ' · rumble' : ''}` : genericDetail(p),
          },
          index: p.index, id: p.id, vendor: ids?.vendor ?? -1, product: ids?.product ?? -1, pad: p, frame, hidden: 0, rumble: 0, rumbleAt: -1e9,
        })
      }
    }
    if (seen !== this.slots.length) {
      for (let i = this.slots.length - 1; i >= 0; i--) if (this.slots[i].frame !== frame) this.slots.splice(i, 1)
    }
    return frame
  }

  /**
   * Hides the browser's own pad for a controller the HID driver is decoding (it would double every press). Pads
   * cannot be matched to HID devices exactly, so one pad per decoded controller is hidden: the same model's pad
   * whose data went stale longest (the decoded one stops updating in the browser) — a second controller of the
   * same model stays usable.
   */
  private hideMirror(ds: DualSense, frame: number): void {
    let best: PadSlot | null = null
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]
      if (s.hidden === frame || s.vendor !== ds.device.vendorId || s.product !== ds.device.productId) continue
      if (!best || s.pad.timestamp < best.pad.timestamp) best = s
    }
    if (best) best.hidden = frame
  }

  /** Browser pads that are the same physical DualSense as an open HID device get rumble from the HID driver. */
  private hidRumbles(s: PadSlot): boolean {
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]
      if (e.ds && e.dev.state === 'ready' && e.ds.device.vendorId === s.vendor && e.ds.device.productId === s.product) return true
    }
    return false
  }

  private pumpPadRumble(now: number): void {
    if (this.slots.length === 0) return
    const level = this.hidden || this.disposed ? 0 : Math.round(this.want.rumble * PAD_RUMBLE.steps) / PAD_RUMBLE.steps
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]
      const act = s.pad.vibrationActuator
      if (!act?.playEffect || s.pad.mapping !== 'standard') continue
      const want = this.hidRumbles(s) ? 0 : level
      if (want === 0) { if (s.rumble !== 0) this.stopPadRumble(s); continue }
      const due = want !== s.rumble ? now - s.rumbleAt >= PAD_RUMBLE.minGapMs : now - s.rumbleAt >= PAD_RUMBLE.refreshMs
      if (!due) continue
      s.rumble = want
      s.rumbleAt = now
      // Runs inside the frame loop (Input.poll): a synchronous throw from a browser actuator must not escape.
      try {
        act.playEffect('dual-rumble', { startDelay: 0, duration: PAD_RUMBLE.durationMs, strongMagnitude: want, weakMagnitude: want * 0.5 })?.catch(() => {})
      } catch { /* unsupported effect: the pad simply stays still */ }
    }
  }

  private stopPadRumble(s: PadSlot): void {
    if (s.rumble === 0) return
    s.rumble = 0
    s.rumbleAt = -1e9
    const act = s.pad.vibrationActuator
    try {
      if (act?.reset) act.reset()?.catch(() => {})
      else act?.playEffect?.('dual-rumble', { duration: 0, strongMagnitude: 0, weakMagnitude: 0 })?.catch(() => {})
    } catch { /* ignore */ }
  }
}

