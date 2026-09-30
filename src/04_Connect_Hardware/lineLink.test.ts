/**
 * Why does this file exist? It proves the HAL/1 line protocol: HELLO/READY handshake with its 2 s deadline
 * and HELLO repeats, framing (split UTF-8, CRLF, overlong lines), PING → PONG, inbound JSON ignored,
 * newest-wins telemetry with one write in flight, and the Web Serial and Nordic UART Service channels
 * (chunking to 20-byte BLE writes, notifications, disconnects, clean close) against mock devices.
 * What breaks if it is removed? A framing or handshake regression would strand DIY devices silently.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkBytes, helloLine, jsonLine, LINE, LineFramer, LineLink, NUS, openBle, openSerial, parseReady, type ByteChannel } from './lineLink.ts'
import type { BleCharacteristic, BleDevice, BleServer, BleValueEvent, ByteReadResult, ByteReader, ByteWriter, SerialOpenOptions, SerialPort } from './web-hardware.d.ts'

const enc = new TextEncoder(), dec = new TextDecoder()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('HELLO and READY lines', () => {
  assert.equal(helloLine('CityHost', '1.0.0'), 'HELLO CityHost/1.0.0\n')
  assert.equal(helloLine('My Brand', '1.0 beta/2'), 'HELLO My-Brand/1.0-beta-2\n')
  assert.equal(parseReady('READY Dash-01'), 'Dash-01')
  assert.equal(parseReady('READY  Seat v2 '), 'Seat v2')
  assert.equal(parseReady('READY'), '')
  assert.equal(parseReady('READY \x07Bell'), 'Bell')
  assert.equal(parseReady(`READY ${'x'.repeat(80)}`)?.length, 40)
  assert.equal(parseReady('ready Dash'), null)
  assert.equal(parseReady('READYDash'), null)
  assert.equal(parseReady('{"READY":1}'), null)
})

test('telemetry lines are single-line JSON', () => {
  assert.equal(jsonLine({ a: 1, b: 'x\ny', c: true }), '{"a":1,"b":"x\\ny","c":true}\n')
  assert.equal(jsonLine({ n: Number.NaN }), '{"n":null}\n')
})

test('framer: split chunks, CRLF, blank lines, UTF-8 split mid-character', () => {
  const f = new LineFramer()
  assert.deepEqual(f.push(enc.encode('HEL')), [])
  assert.deepEqual(f.push(enc.encode('LO\r\nPI')), ['HELLO'])
  assert.deepEqual(f.push(enc.encode('NG\n\n\r\n')), ['PING'])
  const b = enc.encode('READY Café\n')
  const cut = b.indexOf(0xc3) + 1
  assert.deepEqual(f.push(b.subarray(0, cut)), [])
  assert.deepEqual(f.push(b.subarray(cut)), ['READY Café'])
})

test('framer: overlong lines are dropped whole, in one chunk or across chunks', () => {
  const f = new LineFramer(8)
  assert.deepEqual(f.push(enc.encode('AAAAAAAAAAAA\nOK\n')), ['OK'])
  assert.deepEqual(f.push(enc.encode('BBBBBB')), [])
  assert.deepEqual(f.push(enc.encode('BBBBBB')), [])
  assert.deepEqual(f.push(enc.encode('BB\nNEXT\n')), ['NEXT'])
  assert.deepEqual(f.push(enc.encode('12345678\n')), ['12345678'], 'exactly at the limit')
})

test('chunkBytes makes zero-copy views of at most n bytes', () => {
  const b = new Uint8Array(41).map((_, i) => i)
  const parts = chunkBytes(b, 20)
  assert.deepEqual(parts.map((p) => p.length), [20, 20, 1])
  assert.equal(parts[1][0], 20)
  assert.equal(parts[1].buffer, b.buffer)
  assert.deepEqual(chunkBytes(new Uint8Array(0), 20), [])
})

class MockChannel implements ByteChannel {
  readonly kind: 'serial' | 'bluetooth'
  readonly written: string[] = []
  closed = false
  gate: Promise<void> | null = null
  fail = false
  respond: ((line: string) => string | null) | null
  private onBytes: ((b: Uint8Array) => void) | null = null
  private onClose: ((r: string) => void) | null = null
  constructor(respond: ((line: string) => string | null) | null = null, kind: 'serial' | 'bluetooth' = 'serial') {
    this.respond = respond
    this.kind = kind
  }
  start(onBytes: (b: Uint8Array) => void, onClose: (r: string) => void) { this.onBytes = onBytes; this.onClose = onClose }
  async write(bytes: Uint8Array) {
    const s = dec.decode(bytes)
    this.written.push(s)
    if (this.fail) throw new Error('device gone')
    const reply = this.respond?.(s)
    if (reply) setTimeout(() => this.feed(reply), 1)
    if (this.gate) await this.gate
  }
  feed(text: string) { this.onBytes?.(enc.encode(text)) }
  drop(reason: string) { this.onClose?.(reason) }
  async close() { this.closed = true }
}

const readyOnHello = (name: string) => (line: string) => (line.startsWith('HELLO ') ? `READY ${name}\r\n` : null)

test('handshake: HELLO <brand>/<version> → READY <name>', async () => {
  const ch = new MockChannel(readyOnHello('Dash'))
  let changes = 0
  const link = new LineLink(ch, { brand: 'CityHost', version: '1.0.0', onChange: () => changes++ })
  assert.equal(await link.start(), 'ready')
  assert.equal(ch.written[0], 'HELLO CityHost/1.0.0\n')
  assert.equal(link.name, 'Dash')
  assert.equal(link.detail, 'HAL/1 · serial')
  assert.ok(changes >= 1)
  assert.equal(LINE.handshakeMs, 2000, 'the contract deadline')
  await link.close()
})

test('handshake: HELLO repeats until a late-booting device answers; boot noise is ignored', async () => {
  let hellos = 0
  const ch = new MockChannel((line) => (line.startsWith('HELLO') && ++hellos === 3 ? 'boot v1.2\nREADY Seat\n' : null))
  const link = new LineLink(ch, { brand: 'CityHost', version: '1.0.0', handshakeMs: 500, helloEveryMs: 20 })
  assert.equal(await link.start(), 'ready')
  assert.equal(link.name, 'Seat')
  const sent = ch.written.length
  await sleep(60)
  assert.equal(ch.written.length, sent, 'no more HELLOs once READY')
  await link.close()
})

test('handshake: no READY before the deadline is an error and closes the channel', async () => {
  const ch = new MockChannel()
  const link = new LineLink(ch, { brand: 'CityHost', version: '1.0.0', handshakeMs: 80, helloEveryMs: 25 })
  const t0 = Date.now()
  assert.equal(await link.start(), 'error')
  assert.ok(Date.now() - t0 >= 70)
  assert.match(link.detail, /no READY within/)
  assert.ok(ch.written.filter((l) => l.startsWith('HELLO')).length >= 2)
  assert.equal(ch.closed, true)
  link.telemetry('{"x":1}\n')
  await sleep(5)
  assert.ok(!ch.written.includes('{"x":1}\n'), 'no telemetry to a failed link')
})

test('PING → PONG; inbound JSON such as {"trigger":…} is ignored', async () => {
  const ch = new MockChannel(readyOnHello('Dash'))
  const link = new LineLink(ch, { brand: 'CityHost', version: '1.0.0' })
  await link.start()
  const before = ch.written.length
  ch.feed('{"trigger":0.8}\nPING\n')
  await sleep(5)
  assert.deepEqual(ch.written.slice(before), ['PONG\n'])
  assert.equal(link.state, 'ready')
  assert.equal(link.linesIn, 3)
  await link.close()
})

test('telemetry: nothing before READY, then newest wins while a write is in flight', async () => {
  const ch = new MockChannel()
  const link = new LineLink(ch, { brand: 'CityHost', version: '1.0.0' })
  const started = link.start()
  link.telemetry('{"early":1}\n')
  ch.feed('READY Dash\n')
  await started
  let release!: () => void
  ch.gate = new Promise((r) => { release = r })
  link.telemetry('{"n":1}\n')
  link.telemetry('{"n":2}\n')
  link.telemetry('{"n":3}\n')
  await sleep(5)
  ch.gate = null
  release()
  await sleep(5)
  const json = ch.written.filter((l) => l.startsWith('{'))
  assert.deepEqual(json, ['{"n":1}\n', '{"n":3}\n'])
  await link.close()
})

test('a dropped link: error during handshake, disconnected after READY; write failures fail the link', async () => {
  const a = new MockChannel()
  const la = new LineLink(a, { brand: 'CityHost', version: '1.0.0' })
  const pa = la.start()
  a.drop('unplugged')
  assert.equal(await pa, 'error')
  assert.equal(la.detail, 'unplugged')

  const b = new MockChannel(readyOnHello('Dash'))
  const lb = new LineLink(b, { brand: 'CityHost', version: '1.0.0' })
  await lb.start()
  b.drop('Bluetooth link lost')
  assert.equal(lb.state, 'disconnected')

  const c = new MockChannel(readyOnHello('Dash'))
  const lc = new LineLink(c, { brand: 'CityHost', version: '1.0.0' })
  await lc.start()
  c.fail = true
  lc.telemetry('{"n":1}\n')
  await sleep(5)
  assert.equal(lc.state, 'error')
  assert.match(lc.detail, /write failed: device gone/)
  assert.equal(c.closed, true)
})

// ── Web Serial channel ───────────────────────────────────────────────────────────────────────────────

class MockPort implements SerialPort {
  readable: { getReader(): ByteReader } | null = null
  writable: { getWriter(): ByteWriter } | null = null
  opened: SerialOpenOptions | null = null
  portClosed = false
  readerLocked = false
  writerLocked = false
  readonly written: string[] = []
  private readonly queue: ByteReadResult[] = []
  private waiting: ((r: ByteReadResult) => void) | null = null

  async open(o: SerialOpenOptions) {
    this.opened = o
    this.readable = {
      getReader: () => {
        this.readerLocked = true
        return {
          read: () => {
            const next = this.queue.shift()
            if (next) return Promise.resolve(next)
            return new Promise<ByteReadResult>((r) => { this.waiting = r })
          },
          cancel: async () => { this.deliver({ done: true }) },
          releaseLock: () => { this.readerLocked = false },
        }
      },
    }
    this.writable = {
      getWriter: () => {
        this.writerLocked = true
        return {
          write: async (chunk: Uint8Array) => { this.written.push(dec.decode(chunk)) },
          close: async () => {},
          releaseLock: () => { this.writerLocked = false },
        }
      },
    }
  }
  async close() {
    if (this.readerLocked || this.writerLocked) throw new Error('streams locked')
    this.portClosed = true
    // Web Serial: a closed port has no streams until it is opened again.
    this.readable = null
    this.writable = null
    this.queue.length = 0
    this.waiting = null
  }
  getInfo() { return { usbVendorId: 0x2341, usbProductId: 0x0043 } }
  deliver(r: ByteReadResult) {
    const w = this.waiting
    this.waiting = null
    if (w) w(r)
    else this.queue.push(r)
  }
  say(text: string) { this.deliver({ value: enc.encode(text), done: false }) }
}

test('serial channel: opens at 115200, reads, writes, and closes with every lock released', async () => {
  const port = new MockPort()
  const ch = await openSerial(port)
  assert.deepEqual(port.opened, { baudRate: 115200 })
  const got: string[] = []
  let closedWith = ''
  ch.start((b) => got.push(dec.decode(b)), (r) => { closedWith = r })
  port.say('READY Dash\n')
  await sleep(1)
  assert.deepEqual(got, ['READY Dash\n'])
  await ch.write(enc.encode('PONG\n'))
  assert.deepEqual(port.written, ['PONG\n'])
  await ch.close()
  assert.equal(port.portClosed, true)
  assert.equal(closedWith, '', 'our own close is not reported as a drop')
})

test('serial channel: the device going away is reported once', async () => {
  const port = new MockPort()
  const ch = await openSerial(port)
  const reasons: string[] = []
  ch.start(() => {}, (r) => reasons.push(r))
  port.deliver({ done: true })
  await sleep(1)
  assert.deepEqual(reasons, ['serial port closed'])
})

test('a full HAL/1 session over a serial port', async () => {
  const port = new MockPort()
  const link = new LineLink(await openSerial(port), { brand: 'CityHost', version: '1.0.0' })
  const started = link.start()
  await sleep(1)
  assert.deepEqual(port.written, ['HELLO CityHost/1.0.0\n'])
  port.say('READY Bench PSU\n')
  assert.equal(await started, 'ready')
  link.telemetry(jsonLine({ speedKmh: 42 }))
  await sleep(1)
  assert.equal(port.written.at(-1), '{"speedKmh":42}\n')
  await link.close()
  assert.equal(port.portClosed, true)
})

// ── Web Bluetooth NUS channel ──────────────────────────────────────────────────────────────────────

class MockCharacteristic implements BleCharacteristic {
  value: DataView | null = null
  notifying = false
  readonly writes: Uint8Array[] = []
  readonly properties: { writeWithoutResponse: boolean }
  writeValueWithoutResponse?: (v: Uint8Array) => Promise<void>
  private readonly listeners = new Set<(e: BleValueEvent) => void>()
  constructor(quick: boolean) {
    this.properties = { writeWithoutResponse: quick }
    if (quick) this.writeValueWithoutResponse = async (v) => { this.writes.push(v.slice()) }
  }
  async writeValue(v: Uint8Array) { this.writes.push(v.slice()) }
  async startNotifications() { this.notifying = true; return this }
  async stopNotifications() { this.notifying = false; return this }
  addEventListener(_t: 'characteristicvaluechanged', l: (e: BleValueEvent) => void) { this.listeners.add(l) }
  removeEventListener(_t: 'characteristicvaluechanged', l: (e: BleValueEvent) => void) { this.listeners.delete(l) }
  notify(text: string) {
    const b = enc.encode(text)
    this.value = new DataView(b.buffer)
    for (const l of this.listeners) l({ target: this })
  }
  get listening() { return this.listeners.size }
}

function mockBle(quick: boolean) {
  const rx = new MockCharacteristic(quick), tx = new MockCharacteristic(false)
  const gone = new Set<() => void>()
  const asked: string[] = []
  const server: BleServer & { disconnected: boolean } = {
    connected: false,
    disconnected: false,
    async connect() { return server },
    disconnect() { server.disconnected = true },
    async getPrimaryService(uuid: string) {
      asked.push(uuid)
      return { getCharacteristic: async (c: string) => { asked.push(c); return c === NUS.rx ? rx : tx } }
    },
  }
  const device: BleDevice = {
    id: 'dev-1', name: 'Nordic_UART', gatt: server,
    addEventListener: (_t, l) => { gone.add(l) },
    removeEventListener: (_t, l) => { gone.delete(l) },
  }
  return { rx, tx, server, device, asked, unplug: () => { for (const l of [...gone]) l() } }
}

test('BLE channel: NUS UUIDs, 20-byte writes without response, notifications in, link loss out', async () => {
  const m = mockBle(true)
  const ch = await openBle(m.device)
  assert.deepEqual(m.asked, [NUS.service, NUS.rx, NUS.tx])
  const got: string[] = []
  const reasons: string[] = []
  ch.start((b) => got.push(dec.decode(b)), (r) => reasons.push(r))
  await sleep(1)
  assert.equal(m.tx.notifying, true)
  const line = jsonLine({ speedKmh: 42.5, gear: 'D', law1: 3, clock: '10:42' })
  await ch.write(enc.encode(line))
  assert.ok(m.rx.writes.every((w) => w.length <= 20))
  assert.equal(m.rx.writes.map((w) => dec.decode(w)).join(''), line)
  m.tx.notify('PING\n')
  assert.deepEqual(got, ['PING\n'])
  m.unplug()
  assert.deepEqual(reasons, ['Bluetooth link lost'])
  assert.equal(m.tx.listening, 0)
})

test('BLE channel: falls back to writeValue; close stops notifications and disconnects', async () => {
  const m = mockBle(false)
  const ch = await openBle(m.device)
  const reasons: string[] = []
  ch.start(() => {}, (r) => reasons.push(r))
  await ch.write(enc.encode('HELLO CityHost/1.0.0\n'))
  assert.deepEqual(m.rx.writes.map((w) => w.length), [20, 1], 'chunked on the fallback writer too')
  assert.equal(m.rx.writes.map((w) => dec.decode(w)).join(''), 'HELLO CityHost/1.0.0\n')
  await ch.close()
  assert.equal(m.tx.notifying, false)
  assert.equal(m.server.disconnected, true)
  m.unplug()
  assert.deepEqual(reasons, [], 'no drop report after our own close')
})

// ── review regressions ─────────────────────────────────────────────────────────────────────────────────

test('READY names lose C1 and bidirectional controls too (they would reorder the HUD / terminal line)', () => {
  assert.equal(parseReady('READY Seat\u202e2v\u202c'), 'Seat2v')
  assert.equal(parseReady('READY A\u2066B\u2069\u200fC\u0085'), 'ABC')
})

test('a PING flood cannot grow the outbound queue: one waiting PONG answers them all', async () => {
  const ch = new MockChannel(readyOnHello('Dash'))
  const link = new LineLink(ch, { brand: 'CityHost', version: '1.0.0' })
  await link.start()
  let release!: () => void
  ch.gate = new Promise((r) => { release = r })
  link.telemetry('{"n":1}\n') // occupies the channel
  const before = ch.written.length
  ch.feed('PING\n'.repeat(5000))
  ch.gate = null
  release()
  await sleep(10)
  const pongs = ch.written.slice(before).filter((l) => l === 'PONG\n').length
  assert.ok(pongs >= 1 && pongs <= 2, `bounded PONGs (${pongs})`)
  await link.close()
})

test('a serial device that drops is closed, so the same port can be opened again when it is re-plugged', async () => {
  const port = new MockPort()
  const link = new LineLink(await openSerial(port), { brand: 'CityHost', version: '1.0.0' })
  const started = link.start()
  port.say('READY Dash\n')
  assert.equal(await started, 'ready')
  port.deliver({ done: true }) // the device went away: the stream ends
  await sleep(5)
  assert.equal(link.state, 'disconnected')
  assert.equal(port.portClosed, true, 'the port was closed after the drop')
  assert.equal(port.writerLocked, false, 'the writer lock was released')
  await link.close()
  const again = new LineLink(await openSerial(port), { brand: 'CityHost', version: '1.0.0' })
  const restarted = again.start()
  port.say('READY Dash\n')
  assert.equal(await restarted, 'ready', 're-opened on the same port object')
  await again.close()
})

test('a channel that cannot start (locked stream) fails the handshake instead of hanging in it', async () => {
  const ch = new MockChannel()
  ch.start = () => { throw new TypeError('ReadableStream is locked') }
  const link = new LineLink(ch, { brand: 'CityHost', version: '1.0.0', handshakeMs: 5000 })
  assert.equal(await link.start(), 'error')
  assert.match(link.detail, /locked/)
  await sleep(1)
  assert.equal(ch.closed, true)
  assert.deepEqual(ch.written, [], 'no HELLO on a dead channel')
})
