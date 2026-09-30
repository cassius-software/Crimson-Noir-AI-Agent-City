/**
 * Why does this file exist? It pins the DualSense output report byte for byte against the documented layout
 * (see the sources in dualsense.ts): trigger-effect bit packing, the 47-byte common block, the USB and
 * Bluetooth framings with an independently computed CRC-32 (node:zlib), firmware parsing, input decoding, and
 * the driver's change-only, rate-limited, one-in-flight writes and its "off" on close.
 * What breaks if it is removed? A layout slip could send wrong bytes to someone's controller unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crc32 as zlibCrc32 } from 'node:zlib'
import {
  buildBtReport, buildUsbReport, COMMON, crc32, decodeInput, detectBus, DS, DsPad, DualSense, fillCommon, heavyMotor,
  isDualSense, lightMotor, outputLength, parseFirmwareInfo, reportCrc, resistanceStrength, wantsVibrationV2,
  writeTriggerFeedback, writeTriggerOff, type DsState,
} from './dualsense.ts'
import type { HidCollectionInfo, HidDevice, HidInputReportEvent } from './web-hardware.d.ts'

const bytes = (a: ArrayLike<number>) => Array.from(a)
const block = (position: number, strength: number) => {
  const out = new Uint8Array(11)
  writeTriggerFeedback(out, 0, position, strength)
  return bytes(out)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Waits for a condition instead of a fixed delay, so a loaded machine cannot flake the test. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await sleep(2)
  }
}

test('CRC-32 matches the standard check value and node:zlib', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
  const data = Uint8Array.from({ length: 200 }, (_, i) => (i * 37 + 11) & 0xff)
  assert.equal(crc32(data), zlibCrc32(data))
  assert.equal(reportCrc(0xa2, 0x31, data, 73), zlibCrc32(Buffer.from([0xa2, 0x31, ...data.subarray(0, 73)])))
  assert.equal(reportCrc(0xa1, 0x31, new DataView(data.buffer), 73), zlibCrc32(Buffer.from([0xa1, 0x31, ...data.subarray(0, 73)])))
})

test('Feedback effect 0x21: 10-bit zone mask + 3-bit (strength − 1) per zone, little-endian', () => {
  assert.deepEqual(block(0, 8), [0x21, 0xff, 0x03, 0xff, 0xff, 0xff, 0x3f, 0, 0, 0, 0])
  assert.deepEqual(block(0, 1), [0x21, 0xff, 0x03, 0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0])
  assert.deepEqual(block(0, 5), [0x21, 0xff, 0x03, 0x24, 0x49, 0x92, 0x24, 0, 0, 0, 0])
  assert.deepEqual(block(3, 4), [0x21, 0xf8, 0x03, 0x00, 0xb6, 0x6d, 0x1b, 0, 0, 0, 0])
  assert.deepEqual(block(9, 8), [0x21, 0x00, 0x02, 0x00, 0x00, 0x00, 0x38, 0, 0, 0, 0])
  assert.deepEqual(block(12, 9), block(9, 8), 'out-of-range parameters clamp')
  assert.deepEqual(block(4, 0), [0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'strength 0 is Off')
})

test('Feedback packing agrees with an independent BigInt model for every position and strength', () => {
  for (let pos = 0; pos <= 9; pos++) {
    for (let str = 1; str <= 8; str++) {
      let zones = 0n, active = 0n
      for (let i = pos; i < 10; i++) { zones |= BigInt(str - 1) << BigInt(3 * i); active |= 1n << BigInt(i) }
      const want = [0x21, Number(active & 0xffn), Number(active >> 8n)]
      for (let k = 0; k < 8; k++) want.push(Number((zones >> BigInt(8 * k)) & 0xffn))
      assert.deepEqual(block(pos, str), want, `pos ${pos} str ${str}`)
    }
  }
})

test('Off effect clears the whole 11-byte block and nothing else', () => {
  const out = new Uint8Array(15).fill(0xee)
  writeTriggerOff(out, 2)
  assert.deepEqual(bytes(out), [0xee, 0xee, 0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xee, 0xee])
})

test('HAL levels quantize to trigger strength and motor bytes', () => {
  assert.equal(resistanceStrength(0), 0)
  assert.equal(resistanceStrength(0.02), 0)
  assert.equal(resistanceStrength(0.021), 1)
  assert.equal(resistanceStrength(0.125), 1)
  assert.equal(resistanceStrength(0.126), 2)
  assert.equal(resistanceStrength(0.5), 4)
  assert.equal(resistanceStrength(1), 8)
  assert.equal(resistanceStrength(7), 8)
  assert.equal(resistanceStrength(Number.NaN), 0)
  assert.equal(resistanceStrength(-1), 0)
  let last = 0
  for (let v = 0; v <= 1; v += 0.001) {
    const s = resistanceStrength(v)
    assert.ok(s >= last && s <= 8)
    last = s
  }
  assert.equal(heavyMotor(0), 0)
  assert.equal(heavyMotor(1), 255)
  assert.equal(heavyMotor(0.5), 132)
  assert.equal(lightMotor(1), 132)
  assert.equal(heavyMotor(Number.NaN), 0)
})

const S = (trigger: number, heavy: number, light: number): DsState => ({ trigger, heavy, light })

test('USB report 0x02: 47 data bytes, exact layout', () => {
  const out = new Uint8Array(DS.usbOutputLength)
  buildUsbReport(out, S(5, 200, 100), false)
  const want = new Array(47).fill(0)
  want[0] = 0x0b // left trigger | haptics select | compatible vibration
  want[2] = 100 // motor_right (light)
  want[3] = 200 // motor_left (heavy)
  want.splice(21, 11, 0x21, 0xff, 0x03, 0x24, 0x49, 0x92, 0x24, 0, 0, 0, 0)
  assert.deepEqual(bytes(out), want)

  buildUsbReport(out, S(5, 200, 100), true)
  want[0] = 0x0a
  want[38] = 0x04 // valid_flag2: compatible vibration v2
  assert.deepEqual(bytes(out), want)
  assert.equal(COMMON.length + 1, 48, 'with the report ID: the USB descriptor size')
})

test('USB report padding past the 47 declared bytes stays zero', () => {
  const out = new Uint8Array(63).fill(0xaa)
  buildUsbReport(out, S(8, 255, 255), false)
  assert.deepEqual(bytes(out.subarray(47)), new Array(16).fill(0))
  assert.equal(out[21], 0x21)
})

test('Bluetooth report 0x31: seq/tag header, common block at 2, CRC-32 LE over 0xA2 0x31 data[0..72]', () => {
  const out = new Uint8Array(DS.btOutputLength)
  buildBtReport(out, S(0, 0, 0), false, 0)
  const want = new Array(77).fill(0)
  want[1] = 0x10
  want[2] = 0x0b
  want[2 + 21] = 0x05
  want.splice(73, 4, 0x3f, 0xf8, 0x33, 0x08) // golden CRC 0x0833f83f
  assert.deepEqual(bytes(out), want)

  buildBtReport(out, S(5, 200, 100), true, 7)
  const want2 = new Array(77).fill(0)
  want2[0] = 0x70
  want2[1] = 0x10
  want2[2] = 0x0a
  want2[4] = 100
  want2[5] = 200
  want2.splice(23, 7, 0x21, 0xff, 0x03, 0x24, 0x49, 0x92, 0x24)
  want2[2 + 38] = 0x04
  want2.splice(73, 4, 0x0c, 0xd0, 0xff, 0xf1) // golden CRC 0xf1ffd00c
  assert.deepEqual(bytes(out), want2)

  const crc = zlibCrc32(Buffer.from([0xa2, 0x31, ...out.subarray(0, 73)]))
  assert.equal(new DataView(out.buffer).getUint32(73, true), crc)
  const common = new Uint8Array(47)
  fillCommon(common, 0, S(5, 200, 100), true)
  assert.deepEqual(bytes(out.subarray(2, 49)), bytes(common), 'same common block as USB')
  assert.equal(DS.btOutputLength + 1, 78, 'with the report ID: DS_OUTPUT_REPORT_BT_SIZE')
})

test('sequence nibble wraps and every frame carries a valid CRC', () => {
  const out = new Uint8Array(77)
  for (let seq = 0; seq < 20; seq++) {
    buildBtReport(out, S(seq % 9, seq * 10, seq), seq % 2 === 0, seq)
    assert.equal(out[0], (seq & 15) << 4)
    assert.equal(new DataView(out.buffer).getUint32(73, true), zlibCrc32(Buffer.from([0xa2, 0x31, ...out.subarray(0, 73)])))
  }
})

const USB_COLLECTIONS: HidCollectionInfo[] = [{ usagePage: 1, usage: 5, outputReports: [{ reportId: 2, items: [{ reportSize: 8, reportCount: 47 }] }] }]
const BT_COLLECTIONS: HidCollectionInfo[] = [{
  usagePage: 1, usage: 5,
  outputReports: [{ reportId: 0x31, items: [{ reportSize: 8, reportCount: 77 }] }, { reportId: 0x32, items: [{ reportSize: 8, reportCount: 141 }] }],
}]

test('bus detection and declared report length come from the descriptor', () => {
  assert.equal(detectBus(USB_COLLECTIONS), 'usb')
  assert.equal(detectBus(BT_COLLECTIONS), 'bluetooth')
  assert.equal(detectBus([]), 'usb')
  assert.equal(outputLength(USB_COLLECTIONS, 2), 47)
  assert.equal(outputLength(BT_COLLECTIONS, 0x31), 77)
  assert.equal(outputLength(USB_COLLECTIONS, 0x31), 0)
  assert.ok(isDualSense(0x054c, 0x0ce6) && isDualSense(0x054c, 0x0df2))
  assert.ok(!isDualSense(0x054c, 0x05c4) && !isDualSense(0x045e, 0x0ce6))
})

function firmwareReport(withId: boolean, update: number): DataView {
  const full = new Uint8Array(64)
  full[0] = 0x20
  full.set(new TextEncoder().encode('Jun  7 2023'), 1)
  const v = new DataView(full.buffer)
  v.setUint32(24, 0x00ab1234, true)
  v.setUint32(28, 0x01020304, true)
  v.setUint16(44, update, true)
  return withId ? v : new DataView(full.slice(1).buffer)
}

test('firmware info parses with or without the report ID byte; vibration v2 rule', () => {
  for (const withId of [true, false]) {
    assert.deepEqual(parseFirmwareInfo(firmwareReport(withId, 0x0215)), { hardware: 0x00ab1234, firmware: 0x01020304, update: 0x0215 })
  }
  assert.equal(parseFirmwareInfo(new DataView(new ArrayBuffer(20))), null)
  assert.equal(wantsVibrationV2(0x0df2, undefined), true)
  assert.equal(wantsVibrationV2(0x0ce6, 0x0214), false)
  assert.equal(wantsVibrationV2(0x0ce6, 0x0215), true)
  assert.equal(wantsVibrationV2(0x0ce6, undefined), false)
})

function inputData(at: number, fields: { x?: number; y?: number; rx?: number; ry?: number; z?: number; rz?: number; b0?: number; b1?: number; b2?: number }, length = 64): DataView {
  const d = new Uint8Array(length)
  d[at] = fields.x ?? 128
  d[at + 1] = fields.y ?? 128
  d[at + 2] = fields.rx ?? 128
  d[at + 3] = fields.ry ?? 128
  d[at + 4] = fields.z ?? 0
  d[at + 5] = fields.rz ?? 0
  d[at + 7] = fields.b0 ?? 0x08
  d[at + 8] = fields.b1 ?? 0
  d[at + 9] = fields.b2 ?? 0
  return new DataView(d.buffer)
}

test('input report decodes into the standard mapping', () => {
  const pad = new DsPad('t', 16)
  decodeInput(inputData(0, { x: 0, y: 255, rx: 128, ry: 64, z: 255, rz: 0, b0: 0x20 | 0x80 | 2, b1: 0x41, b2: 0x01 }), 0, pad, 5)
  assert.deepEqual(pad.axes.map((a) => Math.round(a * 100) / 100), [-1, 1, 0, -0.5])
  const pressed = pad.buttons.map((b) => b.pressed)
  assert.deepEqual(pressed.map((p, i) => (p ? i : -1)).filter((i) => i >= 0), [0, 3, 4, 6, 10, 15, 16])
  assert.equal(pad.buttons[6].value, 1)
  assert.equal(pad.buttons[7].value, 0)
  assert.equal(pad.timestamp, 5)
  const hat = (h: number) => {
    decodeInput(inputData(0, { b0: h }), 0, pad, 0)
    return [12, 13, 14, 15].map((i) => (pad.buttons[i].pressed ? 1 : 0)).join('')
  }
  // up down left right
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(hat), ['1000', '1001', '0001', '0101', '0100', '0110', '0010', '1010', '0000'])
})

// ── driver ───────────────────────────────────────────────────────────────────────────────────────────

class MockHid implements HidDevice {
  opened = false
  readonly vendorId = 0x054c
  readonly productId: number
  readonly productName = 'Wireless Controller'
  readonly collections: HidCollectionInfo[]
  readonly sent: { id: number; data: number[] }[] = []
  feature: DataView | null
  gate: Promise<void> | null = null
  fail = false
  readonly listeners = new Set<(e: HidInputReportEvent) => void>()
  constructor(collections: HidCollectionInfo[], productId = 0x0ce6, feature: DataView | null = firmwareReport(true, 0x0200)) {
    this.collections = collections
    this.productId = productId
    this.feature = feature
  }
  async open() { this.opened = true }
  async close() { this.opened = false }
  sendReport(id: number, data: Uint8Array): Promise<void> {
    this.sent.push({ id, data: bytes(data) })
    if (this.fail) return Promise.reject(new Error('NetworkError'))
    return this.gate ?? Promise.resolve()
  }
  async receiveFeatureReport(): Promise<DataView> {
    if (!this.feature) throw new Error('NotAllowedError')
    return this.feature
  }
  addEventListener(_t: 'inputreport', l: (e: HidInputReportEvent) => void) { this.listeners.add(l) }
  removeEventListener(_t: 'inputreport', l: (e: HidInputReportEvent) => void) { this.listeners.delete(l) }
  emit(reportId: number, data: DataView) { for (const l of this.listeners) l({ reportId, data }) }
}

test('driver: USB open sends one neutral report sized to the descriptor, then writes change-only', async () => {
  const dev = new MockHid(USB_COLLECTIONS)
  const ds = new DualSense(dev, { minIntervalMs: 0 })
  await ds.open()
  assert.equal(ds.bus, 'usb')
  assert.equal(ds.vibrationV2, false, 'update 2.00 < 2.21')
  assert.equal(dev.sent.length, 1)
  assert.equal(dev.sent[0].id, 0x02)
  assert.equal(dev.sent[0].data.length, 47)
  assert.equal(dev.sent[0].data[0], 0x0b)
  assert.equal(dev.sent[0].data[21], 0x05)

  assert.equal(ds.set(0.5, 1), true)
  await sleep(5)
  assert.equal(dev.sent.length, 2)
  assert.deepEqual(dev.sent[1].data.slice(21, 22), [0x21])
  assert.equal(dev.sent[1].data[3], 255)
  assert.equal(ds.set(0.45, 1), false, 'same quantized strength (4)')
  await sleep(5)
  assert.equal(dev.sent.length, 2)
  await ds.close()
  assert.equal(dev.sent.length, 3)
  assert.equal(dev.sent[2].data[21], 0x05, 'off effect on close')
  assert.equal(dev.sent[2].data[3], 0, 'motors off on close')
  assert.equal(dev.opened, false)
})

test('driver: rate limit coalesces bursts into one trailing write of the newest state', async () => {
  const dev = new MockHid(USB_COLLECTIONS)
  const ds = new DualSense(dev, { minIntervalMs: 40 })
  await ds.open()
  for (let i = 1; i <= 8; i++) ds.set(i / 8, 0)
  assert.equal(dev.sent.length, 1)
  await until(() => dev.sent.length === 2)
  await sleep(60)
  assert.equal(dev.sent.length, 2, 'exactly one trailing write')
  assert.deepEqual(dev.sent[1].data.slice(21, 32), block(0, 8))
  await ds.close()
})

test('driver: never two writes in flight; the newest state follows when the first settles', async () => {
  const dev = new MockHid(USB_COLLECTIONS)
  const ds = new DualSense(dev, { minIntervalMs: 0 })
  await ds.open()
  let release!: () => void
  dev.gate = new Promise((r) => { release = r })
  ds.set(0.25, 0)
  ds.set(0.75, 0)
  ds.set(1, 0)
  await sleep(5)
  assert.equal(dev.sent.length, 2, 'second write waits for the first')
  dev.gate = null
  release()
  await sleep(5)
  assert.equal(dev.sent.length, 3)
  assert.deepEqual(dev.sent[2].data.slice(21, 32), block(0, 8))
  await ds.close()
})

test('driver: firmware ≥ 2.21 selects vibration v2; failed writes are reported, not thrown', async () => {
  const dev = new MockHid(USB_COLLECTIONS, 0x0ce6, firmwareReport(false, 0x0215))
  const status: string[] = []
  const ds = new DualSense(dev, { minIntervalMs: 0, onStatus: (s) => status.push(s) })
  await ds.open()
  assert.equal(ds.vibrationV2, true)
  assert.equal(dev.sent[0].data[0], 0x0a)
  assert.equal(dev.sent[0].data[38], 0x04)
  dev.fail = true
  ds.set(1, 0)
  await sleep(5)
  assert.equal(status.at(-1), 'NetworkError')
  dev.fail = false
  ds.set(0, 0)
  await sleep(5)
  assert.equal(status.at(-1), '', 'recovery is reported')
  await ds.close()
})

test('driver: unreadable firmware still works in classic rumble mode; the Edge always uses v2', async () => {
  const ds = new DualSense(new MockHid(USB_COLLECTIONS, 0x0ce6, null), { minIntervalMs: 0 })
  await ds.open()
  assert.equal(ds.firmware, null)
  assert.equal(ds.vibrationV2, false)
  await ds.close()
  const edge = new DualSense(new MockHid(USB_COLLECTIONS, 0x0df2, null), { minIntervalMs: 0 })
  await edge.open()
  assert.equal(edge.name, 'DualSense Edge')
  assert.equal(edge.vibrationV2, true)
  await edge.close()
})

function btInput(fields: Parameters<typeof inputData>[1], corrupt = false): DataView {
  const v = inputData(1, fields, 77)
  const d = new Uint8Array(v.buffer)
  d[0] = 0x07
  const crc = zlibCrc32(Buffer.from([0xa1, 0x31, ...d.subarray(0, 73)]))
  v.setUint32(73, corrupt ? crc ^ 1 : crc, true)
  return v
}

test('driver: Bluetooth uses 0x31 with rolling sequence and decodes CRC-valid full input reports', async () => {
  const dev = new MockHid(BT_COLLECTIONS)
  let now = 1000
  const ds = new DualSense(dev, { minIntervalMs: 0, now: () => now })
  await ds.open()
  assert.equal(ds.bus, 'bluetooth')
  ds.set(1, 0)
  await sleep(5)
  ds.set(0, 1)
  await sleep(5)
  assert.deepEqual(dev.sent.map((s) => [s.id, s.data.length, s.data[0], s.data[1]]), [[0x31, 77, 0x00, 0x10], [0x31, 77, 0x10, 0x10], [0x31, 77, 0x20, 0x10]])
  for (const s of dev.sent) {
    const d = Uint8Array.from(s.data)
    assert.equal(new DataView(d.buffer).getUint32(73, true), zlibCrc32(Buffer.from([0xa2, 0x31, ...d.subarray(0, 73)])))
  }

  assert.equal(ds.inputLive(), false)
  dev.emit(0x31, btInput({ x: 255, b0: 0x28 }, true))
  assert.equal(ds.crcFailures, 1)
  assert.equal(ds.inputLive(), false, 'corrupt reports are ignored')
  dev.emit(0x01, inputData(0, { x: 0 }, 9))
  assert.equal(ds.inputLive(), false, 'the simple report is left to the Gamepad API')
  dev.emit(0x31, btInput({ x: 255, b0: 0x28 }))
  assert.equal(ds.inputLive(), true)
  assert.equal(ds.pad.axes[0], 1)
  assert.equal(ds.pad.buttons[0].pressed, true)
  now += 300
  assert.equal(ds.inputLive(), false, 'goes stale after 250 ms')
  await ds.close()
  assert.equal(dev.listeners.size, 0)
  assert.equal(ds.pad.connected, false)
})

test('driver: panic() sends a neutral report immediately without disturbing the sequence', async () => {
  const dev = new MockHid(BT_COLLECTIONS)
  const ds = new DualSense(dev, { minIntervalMs: 1000 })
  await ds.open()
  ds.panic()
  assert.equal(dev.sent.length, 2)
  assert.equal(dev.sent[1].data[0], 0x10)
  assert.equal(dev.sent[1].data[2 + 21], 0x05)
  await ds.close()
})

// ── lifecycle races (each of these failed before the per-device serialization and the ready gate) ──────────

test('driver: set() before open() finishes never writes early or on the wrong bus; open sends the latest state', async () => {
  const dev = new MockHid(BT_COLLECTIONS)
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  dev.open = async () => { await gate; dev.opened = true }
  const ds = new DualSense(dev, { minIntervalMs: 0 })
  const opening = ds.open()
  ds.set(1, 0)
  await sleep(5)
  assert.equal(dev.sent.length, 0, 'nothing is written before the bus and report size are known')
  release()
  await opening
  assert.equal(dev.sent.length, 1)
  assert.equal(dev.sent[0].id, 0x31, 'a Bluetooth pad only ever gets report 0x31')
  assert.equal(dev.sent[0].data[2 + 21], 0x21, 'the open report carries the state requested meanwhile')
  await ds.close()
})

test('driver: close() during open() leaves no listener, no open device and a neutral trigger', async () => {
  for (const stage of ['open', 'feature', 'write'] as const) {
    const dev = new MockHid(BT_COLLECTIONS)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    if (stage === 'open') dev.open = async () => { await gate; dev.opened = true }
    if (stage === 'feature') dev.receiveFeatureReport = async () => { await gate; throw new Error('NotAllowedError') }
    if (stage === 'write') dev.gate = gate.then(() => { dev.gate = null })
    const ds = new DualSense(dev, { minIntervalMs: 0 })
    const opening = ds.open()
    await sleep(2)
    ds.set(1, 1)
    const closing = ds.close()
    assert.equal(ds.set(1, 1), false, `${stage}: set() after close() is ignored`)
    await sleep(5) // let close() get as far as it can while the open is still stuck
    release()
    await assert.rejects(opening, /closed while opening/, stage)
    await closing
    assert.equal(dev.opened, false, `${stage}: device closed`)
    assert.equal(dev.listeners.size, 0, `${stage}: no input listener left behind`)
    assert.ok(dev.sent.length >= 1, `${stage}: an opened device is reset before it is closed`)
    assert.equal(dev.sent.at(-1)!.data[2 + 21], 0x05, `${stage}: the last report is Off`)
    assert.equal(dev.sent.at(-1)!.data[2 + 3], 0, `${stage}: motors off`)
  }
})

test('driver: a second driver on the same device takes over only after the first has reset and closed it', async () => {
  const dev = new MockHid(USB_COLLECTIONS)
  const log: string[] = []
  const open = dev.open.bind(dev), close = dev.close.bind(dev)
  dev.open = async () => { log.push('open'); await open() }
  dev.close = async () => { log.push('close'); await close() }
  const a = new DualSense(dev, { minIntervalMs: 0 })
  await a.open()
  a.set(1, 0)
  await sleep(5)
  const b = new DualSense(dev, { minIntervalMs: 0 })
  await b.open()
  assert.deepEqual(log, ['open', 'close', 'open'], 'the old driver closed the device before the new one opened it')
  assert.equal(dev.opened, true)
  a.set(0.5, 1)
  await sleep(5)
  assert.equal(dev.sent.at(-1)!.data[21], 0x05, 'the retired driver writes nothing more')
  assert.equal(b.set(1, 0), true)
  await sleep(5)
  assert.equal(dev.sent.at(-1)!.data[21], 0x21)
  await b.close()
  assert.equal(dev.opened, false)
})

test('driver: a failed write is retried, so an Off that failed still lands', async () => {
  const dev = new MockHid(USB_COLLECTIONS)
  const status: string[] = []
  const ds = new DualSense(dev, { minIntervalMs: 0, onStatus: (s) => status.push(s) })
  await ds.open()
  ds.set(1, 0)
  await sleep(5)
  dev.fail = true
  ds.set(0, 0)
  await until(() => status.includes('NetworkError'))
  const failed = dev.sent.length
  dev.fail = false
  await until(() => dev.sent.length > failed, 2000)
  assert.equal(dev.sent.at(-1)!.data[21], 0x05, 'the retry sends Off')
  assert.equal(status.at(-1), '', 'recovery is reported')
  const n = dev.sent.length
  await sleep(400)
  assert.equal(dev.sent.length, n, 'no retries once a write succeeded')
  await ds.close()
})

test('driver: a synchronous throw from sendReport is reported, never thrown into the caller', async () => {
  const dev = new MockHid(USB_COLLECTIONS)
  const ds = new DualSense(dev, { minIntervalMs: 0 })
  await ds.open()
  dev.sendReport = () => { throw new Error('InvalidStateError') }
  assert.doesNotThrow(() => ds.set(1, 0))
  assert.doesNotThrow(() => ds.panic())
  await sleep(5)
  assert.ok(ds.failures >= 1)
  await ds.close()
})
