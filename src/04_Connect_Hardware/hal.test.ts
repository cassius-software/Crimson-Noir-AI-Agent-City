// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the HAL bus end to end against a mock navigator: silent degradation
 * when WebHID / Web Serial / Web Bluetooth / Gamepad are missing, autoconnect of granted devices only,
 * choosers requested synchronously (user-gesture rule), change-only outputs to the DualSense and to pad
 * rumble without double-driving one controller, 10 Hz telemetry to HAL/1 devices, hot-plug, the HUD
 * summary, visibility/pagehide safety, and dispose sending the "off" effect.
 * What breaks if it is removed? A regression could leave a trigger stiff or prompt at the wrong time.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crc32 as zlibCrc32 } from 'node:zlib'
import { BRAND } from '../brand.ts'
import { HalBus } from './hal.ts'
import { NUS } from './lineLink.ts'
import type {
  BleCharacteristic, BleDevice, BleRequestOptions, BleServer, BleValueEvent, ByteReadResult, GamepadLike, HardwareNavigator, Hid,
  HidCollectionInfo, HidConnectionEvent, HidDevice, HidDeviceFilter, HidInputReportEvent, Serial, SerialConnectionEvent, SerialPort,
} from './web-hardware.d.ts'

const enc = new TextEncoder(), dec = new TextDecoder()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Waits for a condition instead of a fixed delay, so a loaded machine cannot flake the test. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await sleep(2)
  }
}
const USB: HidCollectionInfo[] = [{ outputReports: [{ reportId: 2, items: [{ reportSize: 8, reportCount: 47 }] }] }]
const BT: HidCollectionInfo[] = [{ outputReports: [{ reportId: 0x31, items: [{ reportSize: 8, reportCount: 77 }] }] }]

class MockHid implements HidDevice {
  opened = false
  readonly vendorId: number
  readonly productId: number
  readonly productName = 'Wireless Controller'
  readonly collections: HidCollectionInfo[]
  readonly sent: { id: number; data: number[] }[] = []
  readonly listeners = new Set<(e: HidInputReportEvent) => void>()
  constructor(productId = 0x0ce6, collections = USB, vendorId = 0x054c) {
    this.vendorId = vendorId
    this.productId = productId
    this.collections = collections
  }
  async open() { this.opened = true }
  async close() { this.opened = false }
  async sendReport(id: number, data: Uint8Array) { this.sent.push({ id, data: Array.from(data) }) }
  async receiveFeatureReport(): Promise<DataView> { throw new Error('NotAllowedError') }
  addEventListener(_t: 'inputreport', l: (e: HidInputReportEvent) => void) { this.listeners.add(l) }
  removeEventListener(_t: 'inputreport', l: (e: HidInputReportEvent) => void) { this.listeners.delete(l) }
  emit(reportId: number, data: DataView) { for (const l of this.listeners) l({ reportId, data }) }
  /** Left-trigger effect byte of the n-th report (common block at 0 on USB, 2 on Bluetooth). */
  trigger(n: number) { const r = this.sent.at(n)!; return r.data[(r.id === 0x31 ? 2 : 0) + 21] }
  motor(n: number) { const r = this.sent.at(n)!; return r.data[(r.id === 0x31 ? 2 : 0) + 3] }
  /** The 47-byte common block of the n-th report. */
  common(n: number) { const r = this.sent.at(n)!; const at = r.id === 0x31 ? 2 : 0; return r.data.slice(at, at + 47) }
}

type Listener<E> = (e: E) => void
class Events<E> {
  readonly map = new Map<string, Set<Listener<E>>>()
  add(t: string, l: Listener<E>) { if (!this.map.has(t)) this.map.set(t, new Set()); this.map.get(t)!.add(l) }
  remove(t: string, l: Listener<E>) { this.map.get(t)?.delete(l) }
  dispatch(t: string, e: E) { for (const l of this.map.get(t) ?? []) l(e) }
  count() { let n = 0; for (const s of this.map.values()) n += s.size; return n }
}

class MockHidApi implements Hid {
  granted: HidDevice[] = []
  requests: HidDeviceFilter[][] = []
  chooser: () => Promise<HidDevice[]> = async () => []
  readonly events = new Events<HidConnectionEvent>()
  async getDevices() { return this.granted }
  requestDevice(o: { filters: HidDeviceFilter[] }) { this.requests.push(o.filters); return this.chooser() }
  addEventListener(t: 'connect' | 'disconnect', l: Listener<HidConnectionEvent>) { this.events.add(t, l) }
  removeEventListener(t: 'connect' | 'disconnect', l: Listener<HidConnectionEvent>) { this.events.remove(t, l) }
}

/** A HAL/1 device on a serial port: answers HELLO with READY <name>, PING with nothing. */
class MockPort implements SerialPort {
  readable: SerialPort['readable'] = null
  writable: SerialPort['writable'] = null
  closed = false
  readonly written: string[] = []
  readonly name: string | null
  private waiting: ((r: ByteReadResult) => void) | null = null
  private readonly queue: ByteReadResult[] = []
  constructor(name: string | null) { this.name = name }
  async open() {
    this.readable = {
      getReader: () => ({
        read: () => {
          const q = this.queue.shift()
          return q ? Promise.resolve(q) : new Promise<ByteReadResult>((r) => { this.waiting = r })
        },
        cancel: async () => this.deliver({ done: true }),
        releaseLock: () => {},
      }),
    }
    this.writable = {
      getWriter: () => ({
        write: async (b: Uint8Array) => {
          const s = dec.decode(b)
          this.written.push(s)
          if (s.startsWith('HELLO ') && this.name) setTimeout(() => this.deliver({ value: enc.encode(`READY ${this.name}\n`), done: false }), 1)
        },
        close: async () => {},
        releaseLock: () => {},
      }),
    }
  }
  async close() { this.closed = true }
  getInfo() { return { usbVendorId: 0x2341, usbProductId: 0x0043 } }
  deliver(r: ByteReadResult) {
    const w = this.waiting
    this.waiting = null
    if (w) w(r)
    else this.queue.push(r)
  }
}

class MockSerialApi implements Serial {
  granted: SerialPort[] = []
  requests = 0
  chooser: () => Promise<SerialPort> = () => Promise.reject(Object.assign(new Error('No port selected'), { name: 'NotFoundError' }))
  readonly events = new Events<SerialConnectionEvent>()
  async getPorts() { return this.granted }
  requestPort() { this.requests++; return this.chooser() }
  addEventListener(t: 'connect' | 'disconnect', l: Listener<SerialConnectionEvent>) { this.events.add(t, l) }
  removeEventListener(t: 'connect' | 'disconnect', l: Listener<SerialConnectionEvent>) { this.events.remove(t, l) }
}

function nusDevice(name: string) {
  const listeners = new Set<(e: BleValueEvent) => void>()
  const tx: BleCharacteristic = {
    value: null,
    startNotifications: async () => tx,
    stopNotifications: async () => tx,
    addEventListener: (_t, l) => { listeners.add(l) },
    removeEventListener: (_t, l) => { listeners.delete(l) },
  }
  const written: string[] = []
  const rx: BleCharacteristic = {
    properties: { writeWithoutResponse: true },
    writeValueWithoutResponse: async (v) => {
      written.push(dec.decode(v))
      if (written.join('').endsWith('\n') && written.join('').includes('HELLO ')) {
        written.length = 0
        setTimeout(() => {
          const b = enc.encode(`READY ${name}\n`)
          ;(tx as { value: DataView | null }).value = new DataView(b.buffer)
          for (const l of listeners) l({ target: tx })
        }, 1)
      }
    },
    startNotifications: async () => rx,
    stopNotifications: async () => rx,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const server: BleServer = {
    connected: false,
    connect: async () => server,
    disconnect: () => {},
    getPrimaryService: async () => ({ getCharacteristic: async (c: string) => (c === NUS.rx ? rx : tx) }),
  }
  const device: BleDevice = { id: `ble-${name}`, name: 'Nordic_UART', gatt: server, addEventListener: () => {}, removeEventListener: () => {} }
  return device
}

function pad(index: number, id: string, pressed: number[] = []): GamepadLike & { effects: { strong: number }[]; resets: number } {
  const p = {
    id, index, connected: true, mapping: 'standard', timestamp: 1, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })),
    effects: [] as { strong: number }[],
    resets: 0,
    vibrationActuator: {
      playEffect: async (_t: 'dual-rumble', o: { strongMagnitude?: number }) => { p.effects.push({ strong: o.strongMagnitude ?? 0 }); return 'complete' },
      reset: async () => { p.resets++; return 'complete' },
    },
  }
  return p
}

function nav(parts: { hid?: MockHidApi; serial?: MockSerialApi; bluetooth?: { requestDevice(o: BleRequestOptions): Promise<BleDevice>; getDevices?(): Promise<BleDevice[]> }; pads?: (GamepadLike | null)[] }): HardwareNavigator {
  return {
    hid: parts.hid,
    serial: parts.serial,
    bluetooth: parts.bluetooth,
    getGamepads: parts.pads ? () => parts.pads! : undefined,
  }
}

test('missing APIs degrade silently', async () => {
  for (const n of [null, {}] as (HardwareNavigator | null)[]) {
    const bus = new HalBus({ navigator: n })
    assert.deepEqual(bus.support(), { hid: false, serial: false, bluetooth: false, gamepad: false })
    await bus.autoconnect()
    bus.output({ triggerResistance: 1, rumble: 1 })
    bus.telemetry({ a: 1 })
    assert.deepEqual(bus.readPads(), [])
    assert.deepEqual(bus.devices(), [])
    assert.equal(bus.summary(), '')
    const d = await bus.pair('hid')
    assert.equal(d?.state, 'error')
    assert.match(d?.detail ?? '', /not available/)
    assert.deepEqual(bus.devices(), [], 'a refused pairing is not listed')
    await bus.dispose()
  }
})

test('APIs that exist but throw (permissions policy) never escape', async () => {
  const boom = () => { throw Object.assign(new Error('disallowed by permissions policy'), { name: 'SecurityError' }) }
  const blocked = {
    hid: { getDevices: boom, requestDevice: boom, addEventListener: boom, removeEventListener: boom },
    serial: { getPorts: boom, requestPort: boom, addEventListener: boom, removeEventListener: boom },
    bluetooth: { requestDevice: boom, getDevices: boom },
    getGamepads: boom,
  } as unknown as HardwareNavigator
  const bus = new HalBus({ navigator: blocked })
  await bus.autoconnect()
  assert.deepEqual(bus.readPads(), [])
  for (const kind of ['hid', 'serial', 'bluetooth'] as const) {
    const d = await bus.pair(kind)
    assert.equal(d?.state, 'error')
    assert.match(d?.detail ?? '', /permissions policy/)
  }
  await bus.dispose()
})

test('support() reflects each API', () => {
  const bus = new HalBus({ navigator: nav({ hid: new MockHidApi(), serial: new MockSerialApi(), bluetooth: { requestDevice: () => Promise.reject(new Error('x')) }, pads: [] }) })
  assert.deepEqual(bus.support(), { hid: true, serial: true, bluetooth: true, gamepad: true })
})

test('autoconnect re-opens granted DualSense controllers only, without prompting', async () => {
  const hid = new MockHidApi()
  const ds = new MockHid(0x0ce6)
  hid.granted = [ds, new MockHid(0x1234, USB, 0x046d), new MockHid(0x05c4)]
  const bus = new HalBus({ navigator: nav({ hid }), hidIntervalMs: 0 })
  await bus.autoconnect()
  assert.equal(hid.requests.length, 0)
  assert.deepEqual(bus.devices().map((d) => [d.transport, d.name, d.state]), [['hid', 'DualSense (USB)', 'ready']])
  assert.equal(bus.summary(), '1 device · DualSense (USB) ready')
  assert.equal(ds.sent.length, 2, 'the lightbar setup, then the neutral report on open')
  assert.equal(ds.sent[0].data[41], 0x02, 'LIGHT_OUT')
  assert.equal(ds.trigger(1), 0x05)
  await bus.dispose()
})

test('pair() requests the chooser synchronously (user gesture) and opens the pick', async () => {
  const hid = new MockHidApi()
  const edge = new MockHid(0x0df2, BT)
  hid.chooser = async () => [edge]
  const bus = new HalBus({ navigator: nav({ hid }), hidIntervalMs: 0 })
  const pending = bus.pair('hid')
  assert.equal(hid.requests.length, 1, 'requestDevice ran before pair() returned')
  assert.deepEqual(hid.requests[0], [{ vendorId: 0x054c, productId: 0x0ce6 }, { vendorId: 0x054c, productId: 0x0df2 }])
  const d = await pending
  assert.equal(d?.name, 'DualSense Edge (Bluetooth)')
  assert.equal(d?.state, 'ready')
  assert.equal(edge.sent[0].id, 0x31)
  await bus.dispose()
})

test('pair(): cancel resolves null; a refused request resolves an unlisted error', async () => {
  const hid = new MockHidApi()
  const bus = new HalBus({ navigator: nav({ hid }) })
  hid.chooser = () => Promise.reject(Object.assign(new Error('No device selected.'), { name: 'NotFoundError' }))
  assert.equal(await bus.pair('hid'), null)
  hid.chooser = () => Promise.reject(Object.assign(new Error('Must be handling a user gesture to show a permission request.'), { name: 'SecurityError' }))
  const d = await bus.pair('hid')
  assert.equal(d?.state, 'error')
  assert.match(d?.detail ?? '', /user gesture/)
  hid.chooser = () => { throw new Error('sync throw') }
  assert.equal((await bus.pair('hid'))?.state, 'error')
  assert.deepEqual(bus.devices(), [])
  await bus.dispose()
  assert.equal(await bus.pair('hid'), null, 'nothing after dispose')
})

test('output(): quantized, change-only writes to the DualSense left trigger and motors', async () => {
  const hid = new MockHidApi()
  const ds = new MockHid()
  hid.granted = [ds]
  const bus = new HalBus({ navigator: nav({ hid }), hidIntervalMs: 0 })
  await bus.autoconnect()
  bus.output({ triggerResistance: 0.5 })
  await sleep(2)
  assert.equal(ds.sent.length, 3)
  assert.equal(ds.trigger(2), 0x21)
  for (let i = 0; i < 20; i++) bus.output({ triggerResistance: 0.5 })
  bus.output({ triggerResistance: 0.45 })
  await sleep(2)
  assert.equal(ds.sent.length, 3, 'same value / same strength: no write')
  bus.output({ rumble: 1 })
  await sleep(2)
  assert.equal(ds.sent.length, 4)
  assert.equal(ds.motor(3), 255)
  assert.equal(ds.trigger(3), 0x21, 'every report carries the full state')
  bus.output({ triggerResistance: -3, rumble: Number.NaN })
  await sleep(2)
  assert.equal(ds.trigger(4), 0x05)
  assert.equal(ds.motor(4), 0)
  await bus.dispose()
})

test('output(): the throttle trigger, the lightbar and each controller\'s seat reach the DualSense', async () => {
  const hid = new MockHidApi()
  const first = new MockHid(), second = new MockHid(0x0df2, BT)
  hid.granted = [first, second]
  const bus = new HalBus({ navigator: nav({ hid }), hidIntervalMs: 0 })
  await bus.autoconnect()
  assert.equal(first.common(-1)[43], 0x04, 'player 1 on the first controller')
  assert.equal(second.common(-1)[43], 0x04, 'no seating plan (one seat in play): the second controller is player 1 too')
  assert.equal(first.common(-1)[1], 0x10, 'player LEDs only: no colour was asked for')
  bus.output({ throttleResistance: 0.5, lightbar: 0xe8203a })
  await sleep(2)
  for (const d of [first, second]) {
    const c = d.common(-1)
    assert.equal(c[10], 0x21, 'the throttle hold on the right trigger')
    assert.equal(c[1], 0x14)
    assert.deepEqual(c.slice(44, 47), [0xe8, 0x20, 0x3a])
  }
  const n = first.sent.length
  bus.output({ throttleResistance: 0.5, lightbar: 0xe8203a, throttleVibration: 0 })
  await sleep(2)
  assert.equal(first.sent.length, n, 'nothing changed: no write')
  bus.output({ throttleVibration: 1 })
  await sleep(2)
  assert.equal(first.common(-1)[10], 0x26, 'a snap replaces the hold')
  bus.output({ lightbar: -1 })
  await sleep(2)
  assert.equal(first.common(-1)[1], 0x10, 'the lightbar is left alone again')
  bus.output({ lightbar: 2.5 })
  await sleep(2)
  assert.equal(first.common(-1)[1], 0x10, 'not a colour: unchanged')
  await bus.dispose()
})

test('hot-plug: unplug marks the row disconnected; re-plug re-opens it', async () => {
  const hid = new MockHidApi()
  const ds = new MockHid()
  hid.granted = [ds]
  const bus = new HalBus({ navigator: nav({ hid }), hidIntervalMs: 0 })
  await bus.autoconnect()
  hid.events.dispatch('disconnect', { device: ds })
  await sleep(2)
  assert.equal(bus.devices()[0].state, 'disconnected')
  assert.equal(bus.summary(), '')
  hid.events.dispatch('connect', { device: ds })
  await until(() => bus.devices()[0]?.state === 'ready')
  assert.deepEqual(bus.devices().map((d) => d.state), ['ready'])
  const other = new MockHid()
  hid.events.dispatch('disconnect', { device: ds })
  hid.events.dispatch('connect', { device: other })
  await sleep(5)
  assert.deepEqual(bus.devices().map((d) => d.state), ['ready'], 'the stale row is retired')
  hid.events.dispatch('connect', { device: new MockHid(0x0001, USB, 0x1234) })
  await sleep(2)
  assert.equal(bus.devices().length, 1, 'non-DualSense HID ignored')
  await bus.dispose()
  assert.equal(hid.events.count(), 0, 'listeners removed')
})

test('serial: granted HAL/1 device handshakes; a silent one errors; telemetry is capped at 10 Hz', async () => {
  const serial = new MockSerialApi()
  const good = new MockPort('Dash Panel'), silent = new MockPort(null)
  serial.granted = [good]
  let now = 0
  const bus = new HalBus({ navigator: nav({ serial }), now: () => now })
  await bus.autoconnect()
  assert.deepEqual(bus.devices().map((d) => [d.transport, d.name, d.state, d.detail]), [['serial', 'Dash Panel', 'ready', 'HAL/1 · serial']])
  // The short name, as one token: the line protocol has no room for the full name's spaces.
  assert.equal(BRAND.short, 'Crimson Noir')
  assert.equal(good.written[0], `HELLO Crimson-Noir/${BRAND.version}\n`)
  for (let i = 0; i < 5; i++) bus.telemetry({ speedKmh: i, gear: 'D', parked: false })
  await sleep(2)
  assert.deepEqual(good.written.filter((l) => l.startsWith('{')), ['{"speedKmh":0,"gear":"D","parked":false}\n'])
  now += 100
  bus.telemetry({ speedKmh: 9 })
  await sleep(2)
  assert.equal(good.written.at(-1), '{"speedKmh":9}\n')

  serial.chooser = async () => silent
  const t0 = Date.now()
  const d = await bus.pair('serial')
  assert.equal(serial.requests, 1)
  assert.equal(d?.state, 'error')
  assert.match(d?.detail ?? '', /no READY within 2 s/)
  assert.ok(Date.now() - t0 >= 1900, 'waited the full 2 s')
  assert.equal(silent.closed, true)
  assert.equal(bus.summary(), '2 devices · Dash Panel ready +1')
  await bus.dispose()
  assert.equal(good.closed, true)
})

test('serial hot-plug: a granted port re-opens on connect and drops on disconnect', async () => {
  const serial = new MockSerialApi()
  const bus = new HalBus({ navigator: nav({ serial }) })
  await bus.autoconnect()
  const port = new MockPort('Seat')
  serial.events.dispatch('connect', { target: port })
  await until(() => bus.devices()[0]?.state === 'ready')
  assert.deepEqual(bus.devices().map((d) => [d.name, d.state]), [['Seat', 'ready']])
  serial.events.dispatch('disconnect', { target: port })
  await sleep(5)
  assert.equal(bus.devices()[0].state, 'disconnected')
  await bus.dispose()
})

test('bluetooth: chooser filtered on the Nordic UART Service, then the HAL/1 handshake', async () => {
  const asked: BleRequestOptions[] = []
  const device = nusDevice('Haptic Seat')
  const bus = new HalBus({ navigator: nav({ bluetooth: { requestDevice: (o) => { asked.push(o); return Promise.resolve(device) } } }) })
  const pending = bus.pair('bluetooth')
  assert.equal(asked.length, 1, 'requested synchronously')
  assert.deepEqual(asked[0], { filters: [{ services: [NUS.service] }], optionalServices: [NUS.service] })
  const d = await pending
  assert.deepEqual([d?.transport, d?.name, d?.state, d?.detail], ['bluetooth', 'Haptic Seat', 'ready', 'HAL/1 · BLE UART'])
  await bus.dispose()
})

test('bluetooth autoconnect: a remembered device out of range is disconnected, not an error', async () => {
  const device: BleDevice = {
    id: 'far', name: 'Far', addEventListener: () => {}, removeEventListener: () => {},
    gatt: { connected: false, connect: () => new Promise<BleServer>(() => {}), disconnect: () => {}, getPrimaryService: () => Promise.reject(new Error('x')) },
  }
  const bus = new HalBus({ navigator: nav({ bluetooth: { requestDevice: () => Promise.reject(new Error('x')), getDevices: async () => [device] } }), bleConnectMs: 30 })
  await bus.autoconnect()
  assert.deepEqual(bus.devices().map((d) => [d.state, d.detail]), [['disconnected', 'Bluetooth connect timed out']])
  assert.equal(bus.summary(), '')
  await bus.dispose()
})

test('gamepads: listed, read every frame, rumble refreshed while held and reset when released', async () => {
  let now = 0
  const letters = pad(0, 'Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')
  const pads: (GamepadLike | null)[] = [letters, null]
  const bus = new HalBus({ navigator: nav({ pads }), now: () => now })
  assert.deepEqual(bus.readPads(), [letters])
  assert.deepEqual(bus.devices().map((d) => [d.id, d.transport, d.name, d.state]), [['gamepad:0', 'gamepad', 'Wireless Controller', 'ready']])
  assert.equal(bus.summary(), '1 device · Wireless Controller ready')
  bus.output({ rumble: 1 })
  assert.deepEqual(letters.effects, [{ strong: 1 }])
  now += 50
  bus.readPads()
  assert.equal(letters.effects.length, 1)
  now += 150
  bus.readPads()
  assert.equal(letters.effects.length, 2, 're-issued before the timed effect lapses')
  bus.output({ rumble: 0 })
  assert.equal(letters.resets, 1)
  pads[0] = null
  bus.readPads()
  assert.deepEqual(bus.devices(), [])
  await bus.dispose()
})

test('a pad without the standard mapping is passed on only once a face button wakes it; one without a stick never', async () => {
  const odd = (index: number, id: string, pressed: number[] = [], axes = [0, 0, 0, 0]): GamepadLike => ({ ...pad(index, id, pressed), mapping: '', axes })
  const standard = pad(2, 'Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')
  const pads: (GamepadLike | null)[] = [odd(0, 'Throttle Quadrant', [], [-0.4, -0.45, 0.3, -0.6]), odd(1, 'Pedals', [], [0]), standard]
  const bus = new HalBus({ navigator: nav({ pads }) })
  assert.deepEqual(bus.readPads(), [standard], 'a quadrant left on the desk, and pedals with no stick, are not passed on')
  const detail = () => bus.devices().map((d) => [d.name, d.detail])
  assert.deepEqual(detail(), [
    ['Throttle Quadrant', 'non-standard mapping (press a face button on it to use it)'],
    ['Pedals', 'non-standard mapping (ignored: no stick)'],
    ['Wireless Controller', 'standard mapping · rumble'],
  ])
  pads[0] = odd(0, 'Throttle Quadrant', [6])
  assert.deepEqual(bus.readPads(), [standard], 'a button past the face buttons does not wake it')
  pads[0] = odd(0, 'Throttle Quadrant', [1])
  assert.deepEqual(bus.readPads(), [pads[0], standard], 'its east button: awake')
  pads[0] = odd(0, 'Throttle Quadrant')
  assert.deepEqual(bus.readPads(), [pads[0], standard], 'and it stays awake')
  assert.equal(detail()[0][1], 'non-standard mapping (best guess by position)')
  pads[1] = odd(1, 'Pedals', [0], [0])
  assert.equal(bus.readPads().length, 2, 'a stickless device stays out')
  // Another device in the slot starts asleep again.
  pads[0] = odd(0, 'Racing Wheel')
  assert.deepEqual(bus.readPads(), [standard])
  await bus.dispose()
})

test('one physical DualSense is never driven twice: HID owns its rumble and, when live, its input', async () => {
  let now = 0
  const hid = new MockHidApi()
  const ctrl = new MockHid(0x0ce6, BT)
  hid.granted = [ctrl]
  const browserDs = pad(0, 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')
  const other = pad(1, 'Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')
  const bus = new HalBus({ navigator: nav({ hid, pads: [browserDs, other] }), now: () => now, hidIntervalMs: 0 })
  await bus.autoconnect()
  bus.readPads()
  bus.output({ rumble: 1 })
  await sleep(2)
  assert.equal(browserDs.effects.length, 0, 'no Gamepad API rumble for the HID-driven DualSense')
  assert.equal(other.effects.length, 1)
  assert.equal(ctrl.motor(-1), 255)

  assert.deepEqual(bus.readPads(), [browserDs, other], 'no decoded input yet: the browser pad is used')
  const data = new Uint8Array(77)
  data[1] = 128; data[2] = 128; data[3] = 128; data[4] = 128; data[8] = 0x08 | 0x20
  new DataView(data.buffer).setUint32(73, zlibCrc32(Buffer.from([0xa1, 0x31, ...data.subarray(0, 73)])), true)
  ctrl.emit(0x31, new DataView(data.buffer))
  const list = bus.readPads()
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'DualSense (HID)')
  assert.equal(list[0].buttons[0].pressed, true)
  assert.equal(list[1], other)
  now += 1000
  assert.deepEqual(bus.readPads(), [browserDs, other], 'stale decoded input falls back to the browser pad')
  await bus.dispose()
})

test('hidden page releases the trigger and rumble; pagehide fires an immediate off report', async () => {
  const g = globalThis as Record<string, unknown>
  const docEvents = new Events<void>(), winEvents = new Events<void>()
  const doc = { visibilityState: 'visible', addEventListener: (t: string, l: () => void) => docEvents.add(t, l), removeEventListener: (t: string, l: () => void) => docEvents.remove(t, l) }
  g.document = doc
  g.addEventListener = (t: string, l: () => void) => winEvents.add(t, l)
  g.removeEventListener = (t: string, l: () => void) => winEvents.remove(t, l)
  try {
    const hid = new MockHidApi()
    const ds = new MockHid()
    hid.granted = [ds]
    const bus = new HalBus({ navigator: nav({ hid }), hidIntervalMs: 0 })
    await bus.autoconnect()
    bus.output({ triggerResistance: 1, rumble: 1 })
    await sleep(2)
    assert.equal(ds.trigger(-1), 0x21)
    doc.visibilityState = 'hidden'
    docEvents.dispatch('visibilitychange', undefined)
    await sleep(2)
    assert.equal(ds.trigger(-1), 0x05)
    assert.equal(ds.motor(-1), 0)
    bus.output({ triggerResistance: 0.3 })
    await sleep(2)
    assert.equal(ds.trigger(-1), 0x05, 'stays released while hidden')
    doc.visibilityState = 'visible'
    docEvents.dispatch('visibilitychange', undefined)
    await sleep(2)
    assert.equal(ds.trigger(-1), 0x21, 'restored on return')
    assert.equal(ds.motor(-1), 255)
    const before = ds.sent.length
    winEvents.dispatch('pagehide', undefined)
    assert.equal(ds.sent.length, before + 1, 'sent at once')
    assert.equal(ds.trigger(-1), 0x05)
    await bus.dispose()
    assert.equal(docEvents.count() + winEvents.count(), 0)
  } finally {
    delete g.document
    delete g.addEventListener
    delete g.removeEventListener
  }
})

test('dispose resets trigger effects and closes every device', async () => {
  const hid = new MockHidApi()
  const ds = new MockHid()
  hid.granted = [ds]
  const bus = new HalBus({ navigator: nav({ hid }), hidIntervalMs: 0 })
  await bus.autoconnect()
  bus.output({ triggerResistance: 1, rumble: 0.5 })
  await sleep(2)
  await bus.dispose()
  assert.equal(ds.trigger(-1), 0x05)
  assert.equal(ds.motor(-1), 0)
  assert.equal(ds.opened, false)
  assert.deepEqual(bus.devices().map((d) => d.state), ['disconnected'])
  const n = ds.sent.length
  bus.output({ triggerResistance: 1 })
  await sleep(2)
  assert.equal(ds.sent.length, n, 'inert after dispose')
})

// ── review regressions ─────────────────────────────────────────────────────────────────────────────────

/** A valid Bluetooth full input report (CRC seed 0xA1) with Cross held. */
function fullReport(): DataView {
  const data = new Uint8Array(77)
  data[1] = 128; data[2] = 128; data[3] = 128; data[4] = 128; data[8] = 0x08 | 0x20
  new DataView(data.buffer).setUint32(73, zlibCrc32(Buffer.from([0xa1, 0x31, ...data.subarray(0, 73)])), true)
  return new DataView(data.buffer)
}

test('a second controller of the same model stays usable while the first is HID-decoded', async () => {
  const now = 0
  const hid = new MockHid(0x0ce6, BT)
  const api = new MockHidApi()
  api.granted = [hid]
  const decodedMirror = pad(0, 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')
  const second = pad(1, 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')
  ;(decodedMirror as { timestamp: number }).timestamp = 10 // frozen when the HID driver switched it to full reports
  ;(second as { timestamp: number }).timestamp = 500 // still streaming to the browser
  const bus = new HalBus({ navigator: nav({ hid: api, pads: [decodedMirror, second] }), now: () => now, hidIntervalMs: 0 })
  await bus.autoconnect()
  hid.emit(0x31, fullReport())
  const list = bus.readPads()
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'DualSense (HID)')
  assert.equal(list[1], second, 'only the stale mirror is hidden, not every pad of that model')
  await bus.dispose()
})

test('nothing is opened once the bus is disposed (autoconnect racing dispose)', async () => {
  let grant!: (list: HidDevice[]) => void
  const api = new MockHidApi()
  api.getDevices = () => new Promise<HidDevice[]>((r) => { grant = r })
  const ds = new MockHid()
  const serial = new MockSerialApi()
  let ports!: (list: SerialPort[]) => void
  serial.getPorts = () => new Promise<SerialPort[]>((r) => { ports = r })
  const port = new MockPort('Dash Panel')
  const bus = new HalBus({ navigator: nav({ hid: api, serial }), hidIntervalMs: 0 })
  const auto = bus.autoconnect()
  await bus.dispose()
  grant([ds])
  ports([port])
  await auto
  await sleep(5)
  assert.equal(ds.opened, false, 'the controller was not opened')
  assert.equal(ds.sent.length, 0, 'no report was sent')
  assert.equal(port.readable, null, 'the serial port was not opened')
  assert.deepEqual(bus.devices(), [])
})

test('gamepad rumble that throws synchronously never escapes into the frame loop', async () => {
  const p = pad(0, 'Odd Pad (STANDARD GAMEPAD Vendor: 1234 Product: 5678)')
  ;(p as { vibrationActuator: unknown }).vibrationActuator = {
    playEffect: () => { throw new Error('NotSupportedError') },
    reset: () => { throw new Error('NotSupportedError') },
  }
  const bus = new HalBus({ navigator: nav({ pads: [p] }) })
  bus.readPads()
  assert.doesNotThrow(() => bus.output({ rumble: 1 }))
  assert.doesNotThrow(() => bus.readPads())
  assert.doesNotThrow(() => bus.output({ rumble: 0 }))
  await bus.dispose()
})

test('a page that starts hidden stiffens nothing until it is shown', async () => {
  const g = globalThis as Record<string, unknown>
  const docEvents = new Events<void>()
  const doc = { visibilityState: 'hidden', addEventListener: (t: string, l: () => void) => docEvents.add(t, l), removeEventListener: (t: string, l: () => void) => docEvents.remove(t, l) }
  g.document = doc
  try {
    const api = new MockHidApi()
    const ds = new MockHid()
    api.granted = [ds]
    const bus = new HalBus({ navigator: nav({ hid: api }), hidIntervalMs: 0 })
    await bus.autoconnect()
    bus.output({ triggerResistance: 1 })
    await sleep(5)
    assert.equal(ds.trigger(-1), 0x05, 'hidden from the start: Off only')
    doc.visibilityState = 'visible'
    docEvents.dispatch('visibilitychange', undefined)
    await sleep(5)
    assert.equal(ds.trigger(-1), 0x21)
    await bus.dispose()
  } finally {
    delete g.document
  }
})

test('re-opening a controller whose writes failed retires the old driver first', async () => {
  const api = new MockHidApi()
  const ds = new MockHid(0x0ce6, BT)
  let fail = false
  const send = ds.sendReport.bind(ds)
  ds.sendReport = (id: number, data: Uint8Array) => (fail ? Promise.reject(new Error('NetworkError')) : send(id, data))
  api.granted = [ds]
  const bus = new HalBus({ navigator: nav({ hid: api }), hidIntervalMs: 0 })
  await bus.autoconnect()
  fail = true
  bus.output({ triggerResistance: 1 })
  await until(() => bus.devices()[0].state === 'error')
  fail = false
  api.events.dispatch('connect', { device: ds })
  await until(() => bus.devices()[0].state === 'ready')
  assert.equal(ds.listeners.size, 1, 'exactly one input listener: the old driver let go of the device')
  assert.equal(ds.opened, true)
  assert.equal(ds.trigger(-1), 0x21, 'the new driver restored the requested resistance')
  await bus.dispose()
  assert.equal(ds.listeners.size, 0)
  assert.equal(ds.trigger(-1), 0x05)
})

test('player LEDs follow the seating plan: the seat, kept through another controller\'s unplug; none for an unseated pad', async () => {
  const now = 0
  const hid = new MockHidApi()
  const a = new MockHid(0x0ce6, BT), b = new MockHid(0x0ce6, BT)
  hid.granted = [a, b]
  const bus = new HalBus({ navigator: nav({ hid }), now: () => now, hidIntervalMs: 0 })
  await bus.autoconnect()
  // Both decode their own input: their pads are 17 and 18 (16 + the bus's serial).
  a.emit(0x31, fullReport()); b.emit(0x31, fullReport())
  assert.deepEqual(bus.readPads().map((p) => p.index), [17, 18])
  const seat = new Map<number, number>([[17, 1], [18, 0]]) // the table seats the first pad as player 2, the second as player 1
  const plan = { players: 3, seatOf: (i: number) => seat.get(i) ?? -1 }
  bus.seatPads(plan)
  await sleep(2)
  assert.equal(a.common(-1)[43], 0x0a, 'the first controller lights player 2: its seat, not its order')
  assert.equal(b.common(-1)[43], 0x04)
  const sentB = b.sent.length
  hid.events.dispatch('disconnect', { device: a })
  await sleep(2)
  seat.delete(17) // the table frees the seat of the pad that left; the other keeps its own
  bus.seatsChanged()
  bus.output({ rumble: 0.5 })
  await sleep(2)
  assert.equal(b.common(-1)[43], 0x04, 'the survivor keeps its number')
  assert.equal(b.sent.length, sentB + 1, 'one report for the rumble, none for a renumbering')
  const c = new MockHid(0x0ce6, BT)
  hid.events.dispatch('connect', { device: c })
  await until(() => c.sent.length >= 2)
  assert.equal(c.common(-1)[43], 0x00, 'a controller whose pad the table has not seated lights nothing')
  c.emit(0x31, fullReport())
  seat.set(19, 2)
  bus.seatsChanged()
  await sleep(2)
  assert.equal(c.common(-1)[43], 0x15, 'seated as player 3')
  assert.equal(b.common(-1)[43], 0x04)
  bus.seatPads(null)
  await sleep(2)
  assert.equal(c.common(-1)[43], 0x04, 'one seat in play: every controller is player 1')
  await bus.dispose()
})

test('player LEDs over USB: a controller\'s seat is its browser pad\'s, two of a model pairing in order', async () => {
  const hid = new MockHidApi()
  const a = new MockHid(), b = new MockHid()
  hid.granted = [a, b]
  const padA = pad(0, 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')
  const padB = pad(1, 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')
  const bus = new HalBus({ navigator: nav({ hid, pads: [padA, padB] }), hidIntervalMs: 0 })
  await bus.autoconnect()
  bus.readPads()
  const seat = new Map<number, number>([[0, 1], [1, 0]])
  bus.seatPads({ players: 2, seatOf: (i) => seat.get(i) ?? -1 })
  await sleep(2)
  assert.equal(a.common(-1)[43], 0x0a, 'the first controller is pad 0, seated as player 2')
  assert.equal(b.common(-1)[43], 0x04, 'the second is pad 1, player 1')
  seat.delete(1)
  bus.seatsChanged()
  await sleep(2)
  assert.equal(b.common(-1)[43], 0x00, 'a pad beyond the free seats lights nothing')
  assert.equal(a.common(-1)[43], 0x0a)
  await bus.dispose()
})

test('a headset session\'s input sources are rows of the xr transport: named by the resolver, ready, with their hand and target-ray mode; never pairable; gone with the session', () => {
  const bus = new HalBus({ navigator: {} })
  assert.equal('xr' in bus.support(), false, 'a headset is not paired: the session brings it')
  const left = { handedness: 'left', targetRayMode: 'tracked-pointer', profiles: ['meta-quest-touch-plus', 'generic-trigger-squeeze-thumbstick'], gamepad: { mapping: 'xr-standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 7 }, () => ({ pressed: false, value: 0 })) } }
  const pinch = { handedness: 'none', targetRayMode: 'transient-pointer', profiles: [], gamepad: null }
  const hand = { handedness: 'right', targetRayMode: 'tracked-pointer', profiles: ['generic-hand-select'], gamepad: null, hand: {} }
  bus.setHeadset([left, pinch, hand])
  assert.deepEqual(bus.devices().map((d) => [d.id, d.transport, d.name, d.state, d.detail]), [
    ['xr:0', 'xr', 'Tracked controller (left)', 'ready', 'tracked-pointer, meta-quest-touch-plus'],
    ['xr:1', 'xr', 'Gaze and pinch', 'ready', 'transient-pointer'],
    ['xr:2', 'xr', 'Tracked hand (right)', 'ready', 'tracked-pointer, generic-hand-select'],
  ])
  for (const d of bus.devices()) assert.match(d.profile ?? '', /by the headset/, d.profile)
  assert.equal(bus.summary(), '3 devices · Tracked controller (left) ready +2')
  bus.setHeadset([pinch])
  assert.deepEqual(bus.devices().map((d) => d.id), ['xr:0'], 'the live list, re-numbered')
  bus.setHeadset(null)
  assert.deepEqual(bus.devices(), [])
  assert.equal(bus.summary(), '')
})
