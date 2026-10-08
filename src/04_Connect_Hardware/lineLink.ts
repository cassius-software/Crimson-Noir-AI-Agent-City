// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is HAL/1, a deliberately tiny, human-readable line protocol for do-it-yourself
 * hardware (a dashboard on a microcontroller, a status light, a haptic seat) over Web Serial or over a
 * Bluetooth LE Nordic UART Service link. UTF-8, one message per '\n'-terminated line ('\r' tolerated):
 *   host → device   HELLO <brand>/<version>     sent on open and every 500 ms until answered (boards that reset
 *                                               when the port opens miss the first one)
 *   device → host   READY <device-name>         must arrive within 2 s of the first HELLO, else the link fails
 *   host → device   {"speedKmh":42,…}           newline-delimited JSON telemetry, ≤ 10 Hz, newest wins
 *   device → host   PING      →   host → device   PONG
 *   device → host   anything else (e.g. {"trigger":0.4}) is read and ignored: a device cannot steer the city.
 * What breaks if it is removed? Serial and Bluetooth LE devices can be neither paired nor fed telemetry.
 *
 * Nordic UART Service UUIDs from Nordic Semiconductor's nRF Connect SDK documentation ("Nordic UART Service
 * (NUS)"): RX 6e400002 is written by the central (us), TX 6e400003 notifies the central.
 */
import type { BleCharacteristic, BleDevice, ByteReader, ByteWriter, SerialPort } from './web-hardware.d.ts'

export const HAL_PROTOCOL = 'HAL/1'

export const NUS = {
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  rx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
} as const

export const LINE = {
  handshakeMs: 2000,
  helloEveryMs: 500,
  /** Longer inbound lines are dropped whole. */
  maxLine: 1024,
  telemetryIntervalMs: 100,
  /** ATT_MTU 23 − 3: the payload every BLE link supports without MTU negotiation (Web Bluetooth exposes none). */
  bleChunk: 20,
  baudRate: 115200,
} as const

const token = (s: string) => s.replace(/[\s/]+/g, '-').replace(/[^\x21-\x7e]/g, '') || '-'

export function helloLine(name: string, version: string): string {
  return `HELLO ${token(name)}/${token(version)}\n`
}

/** The device name from a READY line ('' when it gave none), or null when the line is not READY. */
export function parseReady(line: string): string | null {
  const m = /^READY(?:[ \t]+(.*))?$/.exec(line.trim())
  if (!m) return null
  return printable(m[1] ?? '').trim().slice(0, 40)
}

/** Unicode bidirectional formatting controls: a device name must not reorder the HUD or terminal line around it. */
const isBidiControl = (c: number) => c === 0x061c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)

/** Drops C0/C1 control characters, DEL and bidi controls (a device name ends up in the HUD and the terminal). */
function printable(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    if (c >= 0x20 && !(c >= 0x7f && c <= 0x9f) && !isBidiControl(c)) out += ch
  }
  return out
}

/** One JSON telemetry line. JSON.stringify never emits a raw newline, so framing cannot break. */
export function jsonLine(fields: Record<string, number | string | boolean>): string {
  return `${JSON.stringify(fields)}\n`
}

/** Byte stream → complete lines. Handles UTF-8 split across chunks, CRLF, blank lines and overlong lines. */
export class LineFramer {
  readonly maxLine: number
  private readonly decoder = new TextDecoder()
  private buf = ''
  private overflow = false

  constructor(maxLine: number = LINE.maxLine) {
    this.maxLine = maxLine
  }

  push(bytes: Uint8Array, out: string[] = []): string[] {
    const text = this.decoder.decode(bytes, { stream: true })
    let start = 0
    for (;;) {
      const nl = text.indexOf('\n', start)
      if (nl < 0) break
      const piece = text.slice(start, nl)
      start = nl + 1
      if (this.overflow) { this.overflow = false; this.buf = ''; continue }
      let line = this.buf + piece
      this.buf = ''
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length > 0 && line.length <= this.maxLine) out.push(line)
    }
    if (!this.overflow) {
      this.buf += text.slice(start)
      if (this.buf.length > this.maxLine) { this.buf = ''; this.overflow = true }
    }
    return out
  }
}

/** Views (no copies) of at most `max` bytes each. */
export function chunkBytes(bytes: Uint8Array, max: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += max) out.push(bytes.subarray(i, Math.min(bytes.length, i + max)))
  return out
}

/** A bidirectional byte pipe: Web Serial port or NUS link. */
export interface ByteChannel {
  readonly kind: 'serial' | 'bluetooth'
  /** Starts delivering inbound bytes; `onClose` fires once when the link drops (not after close()). */
  start(onBytes: (bytes: Uint8Array) => void, onClose: (reason: string) => void): void
  write(bytes: Uint8Array): Promise<void>
  close(): Promise<void>
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Opens (unless already open) a Web Serial port at 115200 8N1. */
export async function openSerial(port: SerialPort, baudRate: number = LINE.baudRate): Promise<ByteChannel> {
  if (!port.readable || !port.writable) await port.open({ baudRate })
  const writable = port.writable
  if (!writable) throw new Error('serial port is not writable')
  const writer: ByteWriter = writable.getWriter()
  let reader: ByteReader | null = null
  let closed = false
  return {
    kind: 'serial',
    start(onBytes, onClose) {
      const readable = port.readable
      if (!readable) { closed = true; onClose('serial port is not readable'); return }
      const r = readable.getReader()
      reader = r
      void (async () => {
        let reason = 'serial port closed'
        try {
          for (;;) {
            const { value, done } = await r.read()
            if (done) break
            if (value && value.length) onBytes(value)
          }
        } catch (e) {
          reason = errorText(e)
        }
        try { r.releaseLock() } catch { /* already released */ }
        if (!closed) { closed = true; onClose(reason) }
      })()
    },
    write: (bytes) => writer.write(bytes),
    async close() {
      closed = true
      try { await reader?.cancel() } catch { /* ignore */ }
      try { reader?.releaseLock() } catch { /* ignore */ }
      try { writer.releaseLock() } catch { /* ignore */ }
      try { await port.close() } catch { /* ignore */ }
    },
  }
}

/** Connects GATT and resolves the Nordic UART Service characteristics. */
export async function openBle(device: BleDevice): Promise<ByteChannel> {
  const gatt = device.gatt
  if (!gatt) throw new Error('no GATT server')
  const server = gatt.connected ? gatt : await gatt.connect()
  const service = await server.getPrimaryService(NUS.service)
  const rx: BleCharacteristic = await service.getCharacteristic(NUS.rx)
  const tx: BleCharacteristic = await service.getCharacteristic(NUS.tx)
  const quick = rx.writeValueWithoutResponse && rx.properties?.writeWithoutResponse !== false
  const writeOne = (chunk: Uint8Array): Promise<void> => {
    if (quick) return rx.writeValueWithoutResponse!(chunk)
    if (rx.writeValueWithResponse) return rx.writeValueWithResponse(chunk)
    if (rx.writeValue) return rx.writeValue(chunk)
    return Promise.reject(new Error('NUS RX is not writable'))
  }
  let closed = false
  let onValue: (() => void) | null = null
  let onGone: (() => void) | null = null
  const detach = () => {
    if (onValue) tx.removeEventListener('characteristicvaluechanged', onValue)
    if (onGone) device.removeEventListener('gattserverdisconnected', onGone)
    onValue = onGone = null
  }
  return {
    kind: 'bluetooth',
    start(onBytes, onClose) {
      const finish = (reason: string) => {
        if (closed) return
        closed = true
        detach()
        onClose(reason)
      }
      onValue = () => {
        const v = tx.value
        if (v && v.byteLength) onBytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
      }
      onGone = () => finish('Bluetooth link lost')
      tx.addEventListener('characteristicvaluechanged', onValue)
      device.addEventListener('gattserverdisconnected', onGone)
      tx.startNotifications().catch((e: unknown) => finish(errorText(e)))
    },
    async write(bytes) {
      for (let i = 0; i < bytes.length; i += LINE.bleChunk) await writeOne(bytes.subarray(i, Math.min(bytes.length, i + LINE.bleChunk)))
    },
    async close() {
      closed = true
      detach()
      try { await tx.stopNotifications() } catch { /* ignore */ }
      try { server.disconnect() } catch { /* ignore */ }
    },
  }
}

export type LinkState = 'handshaking' | 'ready' | 'error' | 'disconnected'

const PONG = 'PONG\n'

export interface LineLinkOptions {
  brand: string
  version: string
  handshakeMs?: number
  helloEveryMs?: number
  /** Called whenever state, name or detail change. */
  onChange?: () => void
}

/** The HAL/1 session over one channel: handshake, PING/PONG, newest-wins telemetry. */
export class LineLink {
  readonly channel: ByteChannel
  state: LinkState = 'handshaking'
  /** From READY ('' until then, or if the device gave none). */
  name = ''
  detail = ''
  linesIn = 0
  linesOut = 0
  private readonly opts: Required<Omit<LineLinkOptions, 'onChange'>> & { onChange: () => void }
  private readonly framer = new LineFramer()
  private readonly encoder = new TextEncoder()
  private readonly control: string[] = []
  private readonly lines: string[] = []
  private telemetryLine: string | null = null
  private writing = false
  private settle: ((s: LinkState) => void) | null = null
  private helloTimer: ReturnType<typeof setInterval> | null = null
  private deadline: ReturnType<typeof setTimeout> | null = null
  private channelClosed: Promise<void> | null = null

  constructor(channel: ByteChannel, opts: LineLinkOptions) {
    this.channel = channel
    this.opts = {
      brand: opts.brand,
      version: opts.version,
      handshakeMs: opts.handshakeMs ?? LINE.handshakeMs,
      helloEveryMs: opts.helloEveryMs ?? LINE.helloEveryMs,
      onChange: opts.onChange ?? (() => {}),
    }
    this.detail = `${HAL_PROTOCOL} handshake`
  }

  /** Sends HELLO and resolves with 'ready', 'error' (no READY in time) or 'disconnected'. */
  start(): Promise<LinkState> {
    return new Promise((resolve) => {
      this.settle = resolve
      // A stream that cannot be read (e.g. still locked) ends the session like a drop instead of stranding it.
      try { this.channel.start((b) => this.onBytes(b), (reason) => this.onDrop(reason)) } catch (e) { this.onDrop(errorText(e)) }
      if (this.state !== 'handshaking') return
      const hello = helloLine(this.opts.brand, this.opts.version)
      this.queue(hello)
      this.helloTimer = setInterval(() => this.queue(hello), this.opts.helloEveryMs)
      this.deadline = setTimeout(() => {
        void this.fail(`no READY within ${(this.opts.handshakeMs / 1000).toFixed(1).replace(/\.0$/, '')} s`)
      }, this.opts.handshakeMs)
    })
  }

  /** Queues one telemetry line (with its '\n'); an unsent older one is replaced. */
  telemetry(line: string): void {
    if (this.state !== 'ready') return
    this.telemetryLine = line
    void this.drain()
  }

  async close(): Promise<void> {
    this.stopTimers()
    if (this.state !== 'disconnected') this.set('disconnected', 'closed')
    await this.closeChannel()
  }

  /**
   * Closes the channel exactly once, whatever ended the session (close, handshake timeout, write failure or the
   * device dropping). After a drop this still matters: a serial port whose streams errored stays open with its
   * writer locked until close() — and a re-plugged port could then never be opened again.
   */
  private closeChannel(): Promise<void> {
    if (!this.channelClosed) {
      this.channelClosed = (async () => {
        try { await this.channel.close() } catch { /* already gone */ }
      })()
    }
    return this.channelClosed
  }

  private onBytes(bytes: Uint8Array): void {
    const lines = this.framer.push(bytes, this.lines)
    for (let i = 0; i < lines.length; i++) this.onLine(lines[i])
    lines.length = 0
  }

  private onLine(line: string): void {
    this.linesIn++
    if (this.state === 'handshaking') {
      const name = parseReady(line)
      if (name !== null) {
        this.stopTimers()
        this.name = name
        this.control.length = 0 // drop HELLOs still queued
        this.set('ready', `${HAL_PROTOCOL} · ${this.channel.kind === 'serial' ? 'serial' : 'BLE UART'}`)
        return
      }
    }
    if (line.trim() !== 'PING' || (this.state !== 'ready' && this.state !== 'handshaking')) return
    // One PONG waiting to go out answers every PING behind it: a PING flood cannot grow the queue.
    if (this.control.at(-1) !== PONG) this.queue(PONG)
  }

  private onDrop(reason: string): void {
    this.stopTimers()
    if (this.state === 'handshaking') this.set('error', reason)
    else if (this.state !== 'disconnected') this.set('disconnected', reason)
    void this.closeChannel()
  }

  private async fail(reason: string): Promise<void> {
    if (this.state !== 'handshaking' && this.state !== 'ready') return
    this.stopTimers()
    this.set('error', reason)
    await this.closeChannel()
  }

  private set(state: LinkState, detail: string): void {
    this.state = state
    this.detail = detail
    this.opts.onChange()
    if (state !== 'handshaking' && this.settle) {
      const s = this.settle
      this.settle = null
      s(state)
    }
  }

  private stopTimers(): void {
    if (this.helloTimer !== null) { clearInterval(this.helloTimer); this.helloTimer = null }
    if (this.deadline !== null) { clearTimeout(this.deadline); this.deadline = null }
  }

  private queue(line: string): void {
    this.control.push(line)
    void this.drain()
  }

  /** One write at a time; control lines (HELLO, PONG) go before telemetry. */
  private async drain(): Promise<void> {
    if (this.writing) return
    this.writing = true
    try {
      for (;;) {
        if (this.state === 'error' || this.state === 'disconnected') break
        let line = this.control.shift()
        if (line === undefined && this.state === 'ready' && this.telemetryLine !== null) {
          line = this.telemetryLine
          this.telemetryLine = null
        }
        if (line === undefined) break
        await this.channel.write(this.encoder.encode(line))
        this.linesOut++
      }
    } catch (e) {
      await this.fail(`write failed: ${errorText(e)}`)
    } finally {
      this.writing = false
    }
  }
}
