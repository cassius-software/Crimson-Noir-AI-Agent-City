// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The shell's HID path (nativeHid.ts over src-tauri/src/hid.rs) cannot be tried on real
 * hardware here, so this proves the page side against a fake shell: the five commands get the arguments the Rust
 * side reads, WebHID's shapes come back (collections the driver's detectBus and outputLength read, a feature
 * report with its ID in front, input reports by path), plug and unplug come out of the list, and the real DualSense
 * driver and HAL bus run through it end to end: setup report, state report, a CRC-valid Bluetooth input report
 * decoded into a pad, and an unplug row. It also pins the wiring: the HAL's default navigator goes through
 * nativeNavigator, lib.rs registers the five commands, Cargo.toml carries hidapi, and the shell lists the same two
 * products the WebHID filters ask for.
 * What breaks if it is removed? The Windows app's controller path could drift from the driver with no test to say.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { crc32 as zlibCrc32 } from 'node:zlib'
import { SHELL_GLOBAL } from '../07_Execute_Actions/desktopShell.ts'
import { detectBus, DS, DUALSENSE_FILTERS, DualSense, outputLength } from './dualsense.ts'
import { HalBus } from './hal.ts'
import { collectionsFor, FEATURE_LENGTH, INPUT_EVENT, matchesFilter, NativeHid, NativeHidDevice, nativeNavigator, POLL_MS, shellCore, type NativeHidInfo, type NativeHidInput, type ShellCore } from './nativeHid.ts'
import type { HardwareNavigator, HidConnectionEvent, HidInputReportEvent } from './web-hardware.d.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await sleep(2)
  }
}

const USB_INFO: NativeHidInfo = { path: '\\\\?\\hid#vid_054c&pid_0ce6#usb', vendorId: 0x054c, productId: 0x0ce6, productName: 'Wireless Controller', usagePage: 1, usage: 5, bus: 'usb' }
const BT_INFO: NativeHidInfo = { path: '\\\\?\\hid#{00001124-0000-1000-8000-00805f9b34fb}&bt', vendorId: 0x054c, productId: 0x0df2, productName: 'DualSense Edge Wireless Controller', usagePage: 1, usage: 5, bus: 'bluetooth' }

/** The firmware feature report (0x20) with its ID in front, as hidapi returns it: update version 2.21 at 44..45. */
function firmwareReport(update = 0x0215): number[] {
  const d = new Uint8Array(FEATURE_LENGTH)
  d[0] = DS.firmwareInfoId
  d[44] = update & 0xff
  d[45] = update >>> 8
  return Array.from(d)
}

/** A fake shell: the five commands as hid.rs answers them, and the one event it emits. */
class FakeShell implements ShellCore {
  list: NativeHidInfo[] = []
  readonly calls: { command: string; args?: Record<string, unknown> }[] = []
  readonly open = new Set<string>()
  readonly writes: { path: string; reportId: number; data: number[] }[] = []
  readonly listeners = new Map<string, Set<(e: { payload: unknown }) => void>>()
  fail: string | null = null
  feature: number[] = firmwareReport()
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, args })
    if (this.fail === command) throw new Error(`${command} refused`)
    const path = args?.path as string | undefined
    switch (command) {
      case 'hid_list': return structuredClone(this.list) as T
      case 'hid_open': {
        const d = this.list.find((x) => x.path === path)
        if (!d) throw new Error('no such controller')
        this.open.add(d.path)
        return structuredClone(d) as T
      }
      case 'hid_write': {
        if (!path || !this.open.has(path)) throw new Error('controller not open')
        const data = args?.data as number[]
        this.writes.push({ path, reportId: args?.reportId as number, data: [...data] })
        return (data.length + 1) as T
      }
      case 'hid_feature': {
        if (!path || !this.open.has(path)) throw new Error('controller not open')
        const length = args?.length as number
        return this.feature.slice(0, length) as T
      }
      case 'hid_close': {
        if (path) this.open.delete(path)
        return undefined as T
      }
      default: throw new Error(`unknown command ${command}`)
    }
  }
  async listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void> {
    const set = this.listeners.get(event) ?? new Set()
    this.listeners.set(event, set)
    const h = handler as (e: { payload: unknown }) => void
    set.add(h)
    return () => { set.delete(h) }
  }
  emit(event: string, payload: unknown): void {
    for (const h of this.listeners.get(event) ?? []) h({ payload })
  }
  /** The injected global the page would see, with this shell under window.__TAURI__. */
  global(): Record<string, unknown> {
    return { [SHELL_GLOBAL]: { core: { invoke: (c: string, a?: Record<string, unknown>) => this.invoke(c, a) }, event: { listen: (e: string, h: (x: { payload: unknown }) => void) => this.listen(e, h) }, window: { getCurrentWindow: () => ({}) } } }
  }
}

/** A CRC-valid Bluetooth input report (0x31) with the given stick and button bytes, as the driver decodes it. */
function btInput(fields: { x?: number; b0?: number; b2?: number }): number[] {
  const d = new Uint8Array(DS.btInputLength)
  d[0] = 0x07
  d[1] = fields.x ?? 128
  d[2] = 128; d[3] = 128; d[4] = 128
  d[8] = fields.b0 ?? 0x08
  d[10] = fields.b2 ?? 0
  const crc = zlibCrc32(Buffer.from([0xa1, 0x31, ...d.subarray(0, 73)]))
  new DataView(d.buffer).setUint32(73, crc, true)
  return Array.from(d)
}

test('shellCore: null in a browser, null without both namespaces, the two calls bound to their namespaces', async () => {
  assert.equal(shellCore({}), null)
  assert.equal(shellCore({ [SHELL_GLOBAL]: null }), null)
  assert.equal(shellCore({ [SHELL_GLOBAL]: { window: { getCurrentWindow: () => ({}) } } }), null, 'the window API alone is not a HID path')
  assert.equal(shellCore({ [SHELL_GLOBAL]: { core: { invoke: () => {} } } }), null, 'without event.listen no input could arrive')
  const seen: unknown[] = []
  const core = { tag: 'core', invoke(this: unknown, c: string, a?: unknown) { seen.push([this === core, c, a]); return Promise.resolve(1) } }
  const event = { tag: 'event', listen(this: unknown, e: string) { seen.push([this === event, e]); return Promise.resolve(() => {}) } }
  const s = shellCore({ [SHELL_GLOBAL]: { core, event } })
  assert.ok(s)
  assert.equal(await s.invoke('x', { a: 1 }), 1)
  await s.listen('y', () => {})
  assert.deepEqual(seen, [[true, 'x', { a: 1 }], [true, 'y']])
})

test('collectionsFor: the bus becomes the collection the driver reads; an unknown bus reads as USB', () => {
  const bt = collectionsFor(BT_INFO)
  assert.equal(detectBus(bt), 'bluetooth')
  assert.equal(outputLength(bt, DS.btOutputId), DS.btOutputLength)
  assert.equal(bt[0].usagePage, 1)
  assert.equal(bt[0].usage, 5)
  const usb = collectionsFor(USB_INFO)
  assert.equal(detectBus(usb), 'usb')
  assert.equal(outputLength(usb, DS.usbOutputId), DS.usbOutputLength)
  assert.equal(outputLength(usb, DS.btOutputId), 0)
  assert.equal(detectBus(collectionsFor({ ...USB_INFO, bus: 'unknown' })), 'usb')
})

test('matchesFilter: every field given must match, as WebHID has it', () => {
  const d = { vendorId: 0x054c, productId: 0x0ce6, usagePage: 1, usage: 5 }
  assert.equal(matchesFilter({}, d), true)
  assert.equal(matchesFilter({ vendorId: 0x054c }, d), true)
  assert.equal(matchesFilter({ vendorId: 0x054c, productId: 0x0df2 }, d), false)
  assert.equal(matchesFilter({ usagePage: 1, usage: 5 }, d), true)
  assert.equal(matchesFilter({ usage: 4 }, d), false)
  for (const f of DUALSENSE_FILTERS) assert.equal(matchesFilter(f, { ...d, productId: f.productId }), true)
})

test('NativeHid: one device per path across calls, requestDevice filters without a chooser, plug and unplug from the list', async () => {
  const shell = new FakeShell()
  shell.list = [USB_INFO]
  const hid = new NativeHid(shell)
  const [a] = await hid.getDevices()
  assert.ok(a instanceof NativeHidDevice)
  assert.equal(a.productId, 0x0ce6)
  assert.equal(a.opened, false)
  assert.deepEqual(a.collections, collectionsFor(USB_INFO))
  const [b] = await hid.getDevices()
  assert.equal(a, b, 'the same object for the same path, so the HAL and the driver can key on it')
  const mine = await hid.requestDevice({ filters: DUALSENSE_FILTERS.map((f) => ({ vendorId: f.vendorId, productId: f.productId })) })
  assert.deepEqual(mine, [a])
  assert.deepEqual(await hid.requestDevice({ filters: [{ vendorId: 0x054c, productId: 0x0df2 }] }), [], 'an Edge filter admits no original DualSense')
  assert.deepEqual(await hid.requestDevice({ filters: [] }), [a], 'no filter: the whole list')
  assert.equal(shell.calls.filter((c) => c.command === 'hid_list').length, 5)

  const events: [string, number][] = []
  const onConnect = (e: HidConnectionEvent) => events.push(['connect', e.device.productId])
  const onDisconnect = (e: HidConnectionEvent) => events.push(['disconnect', e.device.productId])
  hid.addEventListener('connect', onConnect)
  hid.addEventListener('disconnect', onDisconnect)
  shell.list = [USB_INFO, BT_INFO]
  await hid.refresh()
  assert.deepEqual(events, [['connect', 0x0df2]])
  await a.open()
  assert.equal(a.opened, true)
  shell.list = [BT_INFO]
  await hid.refresh()
  assert.deepEqual(events, [['connect', 0x0df2], ['disconnect', 0x0ce6]])
  assert.equal(a.opened, false, 'an unplugged controller is closed without a command')
  await assert.rejects(a.sendReport(2, new Uint8Array(47)), /not open/)
  assert.equal(shell.calls.filter((c) => c.command === 'hid_close').length, 0)
  const [c] = await hid.getDevices()
  assert.equal(c.productId, 0x0df2)
  hid.removeEventListener('connect', onConnect)
  hid.removeEventListener('disconnect', onDisconnect)
  hid.dispose()
})

test('NativeHid: the first list is the baseline, as getDevices is in WebHID; only a later arrival is a connect', async () => {
  const shell = new FakeShell()
  shell.list = [USB_INFO]
  const hid = new NativeHid(shell)
  const events: string[] = []
  hid.addEventListener('connect', (e) => events.push(`connect ${e.device.productId.toString(16)}`))
  hid.addEventListener('disconnect', (e) => events.push(`disconnect ${e.device.productId.toString(16)}`))
  await hid.refresh()
  assert.deepEqual(events, [], 'a controller already there when the page starts is for getDevices, not an event')
  shell.list = [USB_INFO, BT_INFO]
  await hid.refresh()
  shell.list = []
  await hid.refresh()
  assert.deepEqual(events, ['connect df2', 'disconnect ce6', 'disconnect df2'])
  hid.dispose()
})

test('NativeHid: the list is polled while anyone listens for plug or unplug, and not otherwise', async () => {
  const shell = new FakeShell()
  const timers: { f: () => void; ms: number; cleared: boolean }[] = []
  const hid = new NativeHid(shell, {
    setInterval: (f, ms) => { const t = { f, ms, cleared: false }; timers.push(t); return t },
    clearInterval: (t) => { (t as { cleared: boolean }).cleared = true },
  })
  assert.equal(timers.length, 0)
  const l = () => {}
  hid.addEventListener('connect', l)
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, POLL_MS)
  hid.addEventListener('disconnect', l)
  assert.equal(timers.length, 1, 'one poll for both kinds')
  timers[0].f()
  await until(() => shell.calls.length === 1)
  assert.equal(shell.calls[0].command, 'hid_list')
  hid.removeEventListener('connect', l)
  assert.equal(timers[0].cleared, false)
  hid.removeEventListener('disconnect', l)
  assert.equal(timers[0].cleared, true)
  hid.addEventListener('connect', l)
  assert.equal(timers.length, 2)
  hid.dispose()
  assert.equal(timers[1].cleared, true)
  hid.addEventListener('connect', l)
  assert.equal(timers.length, 2, 'disposed: no poll comes back')
})

test('NativeHidDevice: the commands get what hid.rs reads, and the answers come back in WebHID shapes', async () => {
  const shell = new FakeShell()
  shell.list = [BT_INFO]
  const hid = new NativeHid(shell)
  const [d] = (await hid.getDevices()) as NativeHidDevice[]
  await assert.rejects(d.receiveFeatureReport(0x20), /not open/)
  await d.open()
  await d.open()
  assert.equal(shell.calls.filter((c) => c.command === 'hid_open').length, 1, 'open is idempotent')
  assert.deepEqual(shell.calls.at(-1), { command: 'hid_open', args: { path: BT_INFO.path } })
  const data = new Uint8Array(DS.btOutputLength)
  data[0] = 0x10; data[76] = 0xff
  await d.sendReport(DS.btOutputId, data)
  assert.deepEqual(shell.writes, [{ path: BT_INFO.path, reportId: DS.btOutputId, data: Array.from(data) }], 'the ID apart from the data, the data as a plain array')
  const fw = await d.receiveFeatureReport(DS.firmwareInfoId)
  assert.deepEqual(shell.calls.at(-1), { command: 'hid_feature', args: { path: BT_INFO.path, reportId: DS.firmwareInfoId, length: FEATURE_LENGTH } })
  assert.ok(fw instanceof DataView)
  assert.equal(fw.byteLength, FEATURE_LENGTH)
  assert.equal(fw.getUint8(0), DS.firmwareInfoId, 'the report ID leads, one of the two forms the driver parses')
  assert.equal(fw.getUint16(44, true), 0x0215)

  const got: HidInputReportEvent[] = []
  const l = (e: HidInputReportEvent) => got.push(e)
  d.addEventListener('inputreport', l)
  await until(() => (shell.listeners.get(INPUT_EVENT)?.size ?? 0) === 1)
  shell.emit(INPUT_EVENT, { path: 'another', reportId: 0x31, data: [1, 2, 3] } satisfies NativeHidInput)
  assert.equal(got.length, 0, 'another path is another controller')
  shell.emit(INPUT_EVENT, { path: BT_INFO.path, reportId: 0x31, data: [1, 2, 3] } satisfies NativeHidInput)
  assert.equal(got.length, 1)
  assert.equal(got[0].reportId, 0x31)
  assert.deepEqual(Array.from(new Uint8Array(got[0].data.buffer)), [1, 2, 3])
  shell.emit(INPUT_EVENT, null)
  shell.emit(INPUT_EVENT, { path: BT_INFO.path })
  assert.equal(got.length, 2, 'a report without data is an empty one, a payload without a path is nothing')
  assert.equal(got[1].data.byteLength, 0)
  d.removeEventListener('inputreport', l)
  shell.emit(INPUT_EVENT, { path: BT_INFO.path, reportId: 0x31, data: [9] })
  assert.equal(got.length, 2)
  d.addEventListener('inputreport', l)
  await d.close()
  await d.close()
  assert.equal(d.opened, false)
  assert.equal(shell.calls.filter((c) => c.command === 'hid_close').length, 1)
  shell.emit(INPUT_EVENT, { path: BT_INFO.path, reportId: 0x31, data: [9] })
  assert.equal(got.length, 2, 'closed: nothing is delivered')
  hid.dispose()
  await until(() => (shell.listeners.get(INPUT_EVENT)?.size ?? 0) === 0)
})

test('NativeHidDevice: a refused command surfaces as the rejection the driver expects', async () => {
  const shell = new FakeShell()
  shell.list = [USB_INFO]
  shell.fail = 'hid_open'
  const hid = new NativeHid(shell)
  const [d] = await hid.getDevices()
  await assert.rejects(d.open(), /hid_open refused/)
  assert.equal(d.opened, false)
  shell.fail = 'hid_write'
  await d.open()
  await assert.rejects(d.sendReport(2, new Uint8Array(47)), /hid_write refused/)
  shell.fail = 'hid_list'
  await assert.rejects(hid.getDevices(), /hid_list refused/)
  hid.dispose()
})

test('the real driver runs over the fake shell: setup report, state report, firmware, CRC-checked input', async () => {
  const shell = new FakeShell()
  shell.list = [BT_INFO]
  const hid = new NativeHid(shell)
  const [d] = await hid.getDevices()
  let now = 1000
  const ds = new DualSense(d, { minIntervalMs: 0, now: () => now })
  await ds.open()
  assert.equal(ds.bus, 'bluetooth')
  assert.equal(ds.edge, true)
  assert.equal(ds.vibrationV2, true)
  assert.deepEqual(ds.firmware, { hardware: 0, firmware: 0, update: 0x0215 })
  assert.equal(ds.describe(), 'both triggers + rumble (v2) + lightbar + paddles · fw 2.21')
  assert.equal(shell.writes.length, 2, 'the lightbar setup report, then the state')
  for (const w of shell.writes) {
    assert.equal(w.reportId, DS.btOutputId)
    assert.equal(w.data.length, DS.btOutputLength)
    const bytes = Uint8Array.from(w.data)
    const crc = zlibCrc32(Buffer.from([DS.outputCrcSeed, DS.btOutputId, ...bytes.subarray(0, 73)]))
    assert.equal(new DataView(bytes.buffer).getUint32(73, true), crc, 'each report carries the CRC the controller checks')
  }
  assert.equal(shell.writes[0].data[2 + 38] & 0x02, 0x02, 'the setup report takes the lightbar')
  ds.set({ triggerResistance: 1, rumble: 0, throttleResistance: 0, throttleVibration: 0, lightbar: -1 })
  await until(() => shell.writes.length === 3)
  assert.equal(shell.writes[2].data[2 + 21], 0x21, 'the left trigger effect reaches the controller')

  shell.emit(INPUT_EVENT, { path: BT_INFO.path, reportId: DS.btInputId, data: btInput({ x: 255, b0: 0x28, b2: 0x40 }) })
  assert.equal(ds.inputLive(now), true)
  assert.equal(ds.pad.axes[0], 1)
  assert.equal(ds.pad.buttons[0].pressed, true, 'cross')
  assert.equal(ds.pad.paddles & 0x04, 0x04, 'the left paddle, an Edge field')
  const corrupt = btInput({ x: 0 })
  corrupt[73] ^= 1
  shell.emit(INPUT_EVENT, { path: BT_INFO.path, reportId: DS.btInputId, data: corrupt })
  assert.equal(ds.crcFailures, 1)
  assert.equal(ds.pad.axes[0], 1, 'a report with a bad CRC changes nothing')
  await ds.close()
  assert.equal(d.opened, false)
  assert.equal(shell.writes.at(-1)!.data[2 + 21], 0x05, 'closed with the effects off')
  hid.dispose()
})

test('HalBus inside the shell: autoconnect opens the listed controller, outputs reach it, an unplug is a row', async () => {
  const shell = new FakeShell()
  shell.list = [USB_INFO]
  const nav = nativeNavigator(null, shell.global(), { setInterval: () => ({}), clearInterval: () => {} })
  assert.ok(nav?.hid instanceof NativeHid)
  const bus = new HalBus({ navigator: nav, hidIntervalMs: 0 })
  assert.deepEqual(bus.support(), { hid: true, serial: false, bluetooth: false, gamepad: false })
  await bus.autoconnect()
  assert.deepEqual(bus.devices().map((x) => [x.transport, x.name, x.state, x.detail]), [['hid', 'DualSense (USB)', 'ready', 'both triggers + rumble (v2) + lightbar · fw 2.21']])
  assert.match(bus.devices()[0].profile ?? '', /^dualsense-usb 105 \(by id, usb 054c:0ce6\)$/)
  assert.equal(shell.open.has(USB_INFO.path), true)
  assert.equal(shell.writes.length, 2)
  assert.equal(shell.writes[0].reportId, DS.usbOutputId)
  assert.equal(shell.writes[0].data.length, DS.usbOutputLength)
  bus.output({ triggerResistance: 0.5, rumble: 1 })
  await until(() => shell.writes.length === 3)
  assert.equal(shell.writes[2].data[21], 0x21)
  assert.equal(shell.writes[2].data[3], 0xff, 'the heavy motor at full')
  shell.list = []
  await (nav.hid as NativeHid).refresh()
  await until(() => bus.devices()[0].state === 'disconnected')
  assert.equal(bus.devices()[0].detail, 'unplugged')
  await bus.dispose()
  ;(nav.hid as NativeHid).dispose()
})

test('nativeNavigator: a browser keeps its navigator; the shell gets its HID with the rest of the navigator intact', () => {
  const browser: HardwareNavigator = { serial: undefined, bluetooth: undefined, getGamepads: () => [] }
  assert.equal(nativeNavigator(browser, {}), browser)
  assert.equal(nativeNavigator(null, {}), null)
  const shell = new FakeShell()
  const serial = {} as NonNullable<HardwareNavigator['serial']>
  const pads = [null]
  const receivers: unknown[] = []
  const real = { serial, hid: { tag: 'webview2' } as unknown as HardwareNavigator['hid'], getGamepads(this: unknown) { receivers.push(this); return pads } }
  const wrapped = nativeNavigator(real, shell.global(), { setInterval: () => ({}), clearInterval: () => {} })
  assert.ok(wrapped)
  assert.ok(wrapped.hid instanceof NativeHid, 'the shell\'s HID even where WebView2 offers navigator.hid: that one has no chooser')
  assert.equal(wrapped.serial, serial)
  assert.equal(wrapped.bluetooth, undefined)
  assert.equal(wrapped.getGamepads!(), pads)
  assert.deepEqual(receivers, [real], 'getGamepads keeps its receiver')
  const bare = nativeNavigator(null, shell.global(), { setInterval: () => ({}), clearInterval: () => {} })
  assert.ok(bare?.hid instanceof NativeHid)
  assert.equal(bare.getGamepads, undefined)
})

test('wiring: the HAL defaults through nativeNavigator, the shell registers the five commands and lists the two products', () => {
  const hal = readFileSync(new URL('./hal.ts', import.meta.url), 'utf8')
  assert.match(hal, /import \{ nativeNavigator \} from '\.\/nativeHid\.ts'/)
  assert.match(hal, /function defaultNavigator\(\): HardwareNavigator \| null \{\n  const g = globalThis as \{ navigator\?: HardwareNavigator \}\n  return nativeNavigator\(g\.navigator \?\? null\)\n\}/)
  const lib = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.match(lib, /^mod hid;$/m)
  assert.match(lib, /\.manage\(hid::HidState::default\(\)\)/)
  assert.match(lib, /generate_handler!\[hid::hid_list, hid::hid_open, hid::hid_write, hid::hid_feature, hid::hid_close\]/)
  const rs = readFileSync(new URL('../../src-tauri/src/hid.rs', import.meta.url), 'utf8')
  for (const c of ['hid_list', 'hid_open', 'hid_write', 'hid_feature', 'hid_close']) assert.match(rs, new RegExp(`#\\[tauri::command\\(async\\)\\]\\npub fn ${c}\\(`))
  assert.match(rs, /app\.emit\("hid-input"/)
  assert.equal(INPUT_EVENT, 'hid-input')
  const allowed = /pub const ALLOWED: &\[\(u16, u16\)\] = &\[(.*)\];/.exec(rs)
  assert.ok(allowed)
  const pairs = [...allowed[1].matchAll(/\(0x([0-9a-f]{4}), 0x([0-9a-f]{4})\)/g)].map((m) => [parseInt(m[1], 16), parseInt(m[2], 16)])
  assert.deepEqual(pairs, DUALSENSE_FILTERS.map((f) => [f.vendorId, f.productId]), 'the shell lists exactly what WebHID is asked for')
  assert.match(rs, /#\[serde\(rename_all = "camelCase"\)\]/, 'HidInfo reaches the page as vendorId, productId, productName')
  assert.match(rs, /#\[cfg\(not\(windows\)\)\]\nmod native/, 'elsewhere than Windows the commands exist and answer')
  const cargo = readFileSync(new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8')
  assert.match(cargo, /\[target\.'cfg\(windows\)'\.dependencies\][^[]*hidapi = \{ version = "2\.6", default-features = false, features = \["windows-native"\] \}/)
  assert.match(cargo, /serde = \{ version = "1", features = \["derive"\] \}/)
  const lock = readFileSync(new URL('../../src-tauri/Cargo.lock', import.meta.url), 'utf8')
  assert.match(lock, /name = "hidapi"/, 'the lockfile carries it (the app builds --locked)')
})

test('a bus that found the shell by itself owns its HID: shellHid is true, and dispose stops the input listener', async () => {
  const shell = new FakeShell()
  shell.list = [USB_INFO]
  const g = globalThis as Record<string, unknown>
  const had = Object.hasOwn(g, SHELL_GLOBAL), before = g[SHELL_GLOBAL]
  g[SHELL_GLOBAL] = shell.global()[SHELL_GLOBAL]
  try {
    const bus = new HalBus({ hidIntervalMs: 0 })
    assert.equal(bus.shellHid, true)
    await bus.autoconnect()
    assert.equal(shell.open.has(USB_INFO.path), true)
    assert.equal(shell.listeners.get(INPUT_EVENT)?.size, 1, 'the input listener was taken out at open')
    await bus.dispose()
    await sleep(2)
    assert.equal(shell.listeners.get(INPUT_EVENT)?.size ?? 0, 0, 'disposed with the bus')
  } finally {
    if (had) g[SHELL_GLOBAL] = before
    else delete g[SHELL_GLOBAL]
  }
  const browser = new HalBus({ navigator: { getGamepads: () => [] } })
  assert.equal(browser.shellHid, false)
  await browser.dispose()
})
