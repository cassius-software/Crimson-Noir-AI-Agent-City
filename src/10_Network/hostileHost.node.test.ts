/**
 * Why does this file exist? It is a hostile host against the Crimson Noir OS runtime's bridge (crimson_noir_os
 * src/wire.rs, bridge.rs, ledger.rs): a minimal WebSocket server of this file's own (node:http takes the upgrade; the
 * RFC 6455 frames and the sealed envelopes are written by hand, the host's own frame code for the honest ones) that
 * speaks `crimson.1` to the real `bridge` binary and, at every stage of a session, answers as the host never would:
 * - the handshake: a 101 whose Sec-WebSocket-Accept does not answer the key, or that speaks another protocol, no 101
 *   at all, a 101 followed by bytes that are no frame;
 * - the frames: fragments, a masked frame from the host's side, 64-bit lengths near 2^63 and one over MAX_FRAME,
 *   reserved bits, a control frame over 125 bytes, a close with no code, text that is not UTF-8;
 * - the JSON: nesting 17 and 32,000 deep, fractions, exponents, leading zeros, a key twice;
 * - the seal: a wrong mac, a replayed number, n = 0, n = 2^53, a 17-digit n;
 * - the protocol: a `ready` that names another configuration, a `verified` for another ledger, a `refused` with a
 *   10 MB reason and one that carries terminal escape sequences, weights that are 65537, 0, -1, a sentry's, a
 *   duplicate, descending or past the pool, 200,000 of them, an `end` whose count disagrees;
 * - a ping flood, a pong flood, a stall after the hello, bytes dribbled one at a time.
 * For each, the bridge must exit non-zero with a `FAIL:` reason, must never print `fleet sync` or `verified by the
 * host`, and must exit within a few seconds. The attacks it survives are proofs; the ones it does not are regression
 * tests for the audit's findings, named `REGRESSION` below, which fail until wire.rs/bridge.rs take the fix:
 * - a per-message deadline in Ws::recv (the read timeout is per read, so pings, pongs or a byte every 19 s hold the
 *   bridge forever);
 * - a bound on the pairs a fetch may carry before its `end` (the pool's size), so a host cannot grow the bridge's
 *   memory without limit;
 * - escaping of the host's text before it is printed (a `refused` reason or a close reason reaches the operator's
 *   terminal raw, escape sequences included; the host's own log escapes them, replication.node.ts loggable).
 * The bridge is the one `cargo build` leaves at crimson_noir_os/target/debug; without it this file is skipped.
 * What breaks if it is removed? A host, or anything between the bridge and it, could hold the bridge, grow it, or
 * talk it into a verdict, and nothing would notice.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { canonical, sha256 } from '../02_Define_The_Rules/integrity.ts'
import { LEDGER_SUBPROTOCOL } from './ledger.ts'
import { AUTH_PREFIX } from './replication.ts'
import { acceptKey, OP, readFrame, writeFrame } from './replication.node.ts'

const OS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'crimson_noir_os')
const BIN = join(OS, 'target', 'debug', 'crimson_noir_os')
const CANONICAL = readFileSync(join(OS, 'containment.canonical'), 'utf8')
const DIGEST = sha256(CANONICAL)
/** The session token: the hostile host takes whatever it is offered, and seals under it as the real host would. */
const TOKEN = 'aG9zdGlsZQ.9999999999999.hostile-host-audit-token'
/** The pool: capacity * stations (containment.canonical), the only indices a weight may have. */
const POOL = 4096 * 8
const SENTRY_ROW = 3072 * 8
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const mac = (n: number, body: unknown): string => createHmac('sha256', TOKEN).update(canonical({ n, body }), 'utf8').digest('hex')
const skip = existsSync(BIN) ? false : `no bridge binary at ${BIN} (cargo build in crimson_noir_os)`

/** The bridge's connection, as the hostile host holds it. */
interface Conn {
  socket: Socket
  /** The next sealed message the bridge sends (its body); the seal and the rising number are checked on the way. */
  next(): Promise<Record<string, unknown>>
  /** `body` sealed under the token as envelope `n` (the next by default), with `mac` forged if given. */
  send(body: unknown, n?: number, forgedMac?: string): void
  /** One text frame of exactly this wire text. */
  text(wire: string): void
  /** Bytes as they are. */
  raw(bytes: Buffer): void
  sent: number
}

/** A hostile host: how it answers the upgrade (the honest 101 by default), and what it does on each session. */
interface Hostile {
  upgrade?: (socket: Socket, key: string) => void
  script?: (c: Conn, session: number) => Promise<void> | void
}

interface Outcome {
  code: number | null
  hung: boolean
  stdout: string
  stderr: string
  ms: number
  /** Sessions the bridge opened. */
  sessions: number
}

const honest101 = (socket: Socket, key: string): void => {
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\nSec-WebSocket-Protocol: ${LEDGER_SUBPROTOCOL}\r\n\r\n`)
}

/** Runs the bridge against `h`; the bridge is killed, and the run reported as hung, past `deadlineMs`. */
async function run(h: Hostile, deadlineMs = 8000): Promise<Outcome> {
  const server = createServer((_req, res) => { res.writeHead(426); res.end() })
  let sessions = 0
  /** The upgraded sockets: node:http stops tracking them, so they are ended here. */
  const sockets = new Set<Socket>()
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('end', () => socket.destroy())
    socket.on('close', () => sockets.delete(socket))
    const key = String(req.headers['sec-websocket-key'] ?? '')
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim())
    assert.ok(offered.includes(LEDGER_SUBPROTOCOL) && offered.includes(AUTH_PREFIX + TOKEN), `the bridge offers crimson.1 and its token: ${offered.join(',')}`)
    const session = ++sessions
    ;(h.upgrade ?? honest101)(socket, key)
    let buf = head
    let received = 0
    const bodies: Record<string, unknown>[] = []
    const waiters: ((b: Record<string, unknown>) => void)[] = []
    const c: Conn = {
      socket,
      sent: 0,
      next: () => new Promise((r) => { const b = bodies.shift(); if (b) r(b); else waiters.push(r) }),
      send: (body, n, forgedMac) => {
        const k = n ?? ++c.sent
        if (n !== undefined && n > c.sent) c.sent = n
        c.text(JSON.stringify({ n: k, body, mac: forgedMac ?? mac(k, body) }))
      },
      text: (wire) => c.raw(writeFrame(OP.text, Buffer.from(wire, 'utf8'))),
      raw: (bytes) => { if (!socket.destroyed) socket.write(bytes) },
    }
    socket.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
      for (;;) {
        const r = readFrame(buf, 1 << 20)
        if (r.kind === 'more') return
        assert.equal(r.kind, 'frame', `the bridge's frames are masked, whole and bounded: ${JSON.stringify(r)}`)
        buf = buf.subarray(r.used)
        if (r.opcode !== OP.text) continue
        const env = JSON.parse(r.payload.toString('utf8')) as { n: number; body: Record<string, unknown>; mac: string }
        assert.equal(env.mac, mac(env.n, env.body), 'the bridge seals under its token')
        assert.ok(env.n > received, 'the bridge numbers its envelopes rising')
        received = env.n
        const w = waiters.shift()
        if (w) w(env.body)
        else bodies.push(env.body)
      }
    })
    void Promise.resolve(h.script?.(c, session)).catch((e: unknown) => { throw e })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const t0 = performance.now()
  const child = spawn(BIN, ['bridge', `ws://127.0.0.1:${port}`], { env: { ...process.env, CRIMSON_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)))
  let deadline: NodeJS.Timeout | undefined
  const code = await Promise.race([exited, new Promise<'hung'>((r) => { deadline = setTimeout(() => r('hung'), deadlineMs) })])
  clearTimeout(deadline)
  const hung = code === 'hung'
  if (hung) {
    child.kill('SIGKILL')
    await exited
  }
  const ms = performance.now() - t0
  for (const s of sockets) s.destroy()
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  return { code: hung ? null : code, hung, stdout, stderr, ms, sessions }
}

/**
 * The verdict every attack must earn: a non-zero exit with a reason, in time, and no sync. An attack at the fetch
 * comes after an honest first session, whose `verified by the host` line is the bridge's own and allowed.
 */
function failed(o: Outcome, why: RegExp, name: string, atFetch = false): void {
  const shown = `${name}: exit ${o.code}${o.hung ? ' (hung, killed)' : ''} after ${o.ms.toFixed(0)} ms\nstdout: ${o.stdout.slice(0, 400)}\nstderr: ${o.stderr.slice(0, 400)}`
  assert.doesNotMatch(o.stdout, atFetch ? /fleet sync/ : /fleet sync|verified by the host/, `${name}: the bridge took the hostile host's word\n${shown}`)
  assert.ok(!o.hung, `${name}: the bridge hung\n${shown}`)
  assert.notEqual(o.code, 0, `${name}: the bridge exited 0\n${shown}`)
  assert.match(o.stderr, /^FAIL: /m, `${name}: no reason\n${shown}`)
  assert.match(o.stderr, why, `${name}: another reason than expected\n${shown}`)
}

/** The honest `ready`. */
const ready = (c: Conn): void => c.send({ t: 'ready', digest: DIGEST, name: 'crimson-noir', capacity: 4096, stations: 8 })

/** Reads the bridge's hello and answers `ready`, then reads its entries and returns its seal. */
async function greetAndTakeLedger(c: Conn): Promise<Record<string, unknown>> {
  const hello = await c.next()
  assert.equal(hello.t, 'hello')
  assert.equal(hello.config, CANONICAL, 'the bridge sends the locked configuration')
  ready(c)
  let m = await c.next()
  let entries = 0
  while (m.t === 'entries') {
    entries += (m.list as unknown[]).length
    m = await c.next()
  }
  assert.equal(m.t, 'seal')
  assert.equal(m.count, entries, 'the seal counts the entries sent')
  return m
}

/**
 * Plays the first session honestly (so the bridge comes back to fetch), and hands the second to `fetching` after its
 * hello, with the seal the bridge sent: an `end` under that seal's digest is what reaches the bridge's own check of
 * the weights (ledger.rs adopt); one under any other digest is refused before it.
 */
const atFetch = (fetching: (c: Conn, seal: Record<string, unknown>) => Promise<void> | void): Hostile => {
  let seal: Record<string, unknown> = {}
  return {
    script: async (c, session) => {
      if (session === 1) {
        seal = await greetAndTakeLedger(c)
        c.send({ t: 'verified', head: seal.head, count: seal.count, weights: seal.weights })
        return
      }
      await c.next()
      ready(c)
      const fetch = await c.next()
      assert.equal(fetch.t, 'fetch')
      await fetching(c, seal)
    },
  }
}

/** A script that waits for the hello and then plays `act`. */
const afterHello = (act: (c: Conn) => Promise<void> | void): Hostile => ({ script: async (c) => { await c.next(); await act(c) } })

/** A raw frame header of any length class, FIN and RSV bits and mask bit as asked. */
function header(opcode: number, len: bigint, o: { fin?: boolean; rsv?: number; masked?: boolean } = {}): Buffer {
  const b0 = ((o.fin ?? true) ? 0x80 : 0) | ((o.rsv ?? 0) << 4) | opcode
  const m = o.masked ? 0x80 : 0
  if (len < 126n) return Buffer.from([b0, m | Number(len)])
  if (len < 65536n) return Buffer.from([b0, m | 126, Number(len >> 8n), Number(len & 0xffn)])
  const h = Buffer.alloc(10)
  h[0] = b0
  h[1] = m | 127
  h.writeBigUInt64BE(len, 2)
  return h
}

test('the handshake: a wrong accept, another protocol, no 101, and a 101 followed by no frame', { skip, timeout: 60_000 }, async () => {
  const cases: [string, Hostile, RegExp][] = [
    ['wrong accept', { upgrade: (s, k) => s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(`${k}x`)}\r\nSec-WebSocket-Protocol: crimson.1\r\n\r\n`) }, /Sec-WebSocket-Accept/],
    ['another protocol', { upgrade: (s, k) => s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(k)}\r\nSec-WebSocket-Protocol: onyx.4\r\n\r\n`) }, /does not speak crimson\.1/],
    ['no protocol', { upgrade: (s, k) => s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(k)}\r\n\r\n`) }, /does not speak crimson\.1/],
    ['no upgrade header', { upgrade: (s, k) => s.write(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${acceptKey(k)}\r\nSec-WebSocket-Protocol: crimson.1\r\n\r\n`) }, /did not upgrade/],
    ['200 OK', { upgrade: (s) => s.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n') }, /refused the upgrade: 200/],
    ['401', { upgrade: (s) => s.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n') }, /refused the upgrade: 401/],
    ['headers that never end', { upgrade: (s) => s.write(`HTTP/1.1 101 Switching Protocols\r\n${'X-Pad: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n'.repeat(100)}`) }, /headers are too long/],
    ['101 then garbage', { upgrade: (s, k) => { honest101(s, k); s.write('garbage that is no frame at all') } }, /fragmented frame/],
    ['101 then a close', { upgrade: (s, k) => { honest101(s, k); s.write(writeFrame(OP.close, Buffer.from([0x0f, 0xa8, 0x62, 0x79, 0x65]))) } }, /closed the session \(4008\): bye/],
    ['101 then the connection closed', { upgrade: (s, k) => { honest101(s, k); s.end() } }, /closed the connection/],
  ]
  for (const [name, h, why] of cases) failed(await run(h), why, name)
})

test('the frames: fragments, a masked frame, lengths near 2^63 and over MAX_FRAME, reserved bits, long control frames, a close with no code, bad UTF-8', { skip, timeout: 90_000 }, async () => {
  const payload = Buffer.from(JSON.stringify({ n: 1, body: { t: 'ready', digest: DIGEST }, mac: mac(1, { t: 'ready', digest: DIGEST }) }))
  const cases: [string, (c: Conn) => void, RegExp][] = [
    ['FIN clear', (c) => c.raw(Buffer.concat([header(OP.text, BigInt(payload.length), { fin: false }), payload])), /fragmented frame/],
    ['a continuation frame', (c) => c.raw(Buffer.concat([header(OP.continuation, BigInt(payload.length)), payload])), /opcode 0/],
    ['masked by the host', (c) => c.raw(Buffer.concat([header(OP.text, BigInt(payload.length), { masked: true }), Buffer.alloc(4), payload])), /masked frame/],
    ['length 2^63 - 1', (c) => c.raw(header(OP.text, 2n ** 63n - 1n)), /over 65536/],
    ['length 2^63', (c) => c.raw(header(OP.text, 2n ** 63n)), /over 65536/],
    ['length 2^64 - 1', (c) => c.raw(header(OP.text, 2n ** 64n - 1n)), /over 65536/],
    ['length MAX_FRAME + 1', (c) => c.raw(Buffer.concat([header(OP.text, 65537n), Buffer.alloc(65537, 0x20)])), /65537 bytes, over 65536/],
    ['a 10 MB refused', (c) => c.raw(Buffer.concat([header(OP.text, 10n * 1024n * 1024n), Buffer.alloc(1 << 20, 0x20)])), /over 65536/],
    ['RSV1', (c) => c.raw(Buffer.concat([header(OP.text, BigInt(payload.length), { rsv: 4 }), payload])), /reserved bits/],
    ['RSV3', (c) => c.raw(Buffer.concat([header(OP.text, BigInt(payload.length), { rsv: 1 }), payload])), /reserved bits/],
    ['a ping of 126 bytes', (c) => c.raw(Buffer.concat([header(OP.ping, 126n), Buffer.alloc(126)])), /control frame over 125/],
    ['a close of 65536 bytes', (c) => c.raw(header(OP.close, 65536n)), /control frame over 125/],
    ['a close with no code', (c) => c.raw(writeFrame(OP.close)), /closed the session \(1005\)/],
    ['a close with one byte', (c) => c.raw(writeFrame(OP.close, Buffer.from([0x03]))), /closed the session \(1005\)/],
    ['text that is not UTF-8', (c) => c.raw(writeFrame(OP.text, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))), /not UTF-8/],
    ['text with a lone surrogate', (c) => c.raw(writeFrame(OP.text, Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22]))), /not UTF-8/],
    ['a binary frame', (c) => c.raw(writeFrame(OP.binary, payload)), /opcode 2/],
    ['opcode 3', (c) => c.raw(Buffer.concat([header(3, BigInt(payload.length)), payload])), /opcode 3/],
    ['opcode 11', (c) => c.raw(Buffer.concat([header(11, 0n)])), /opcode 11/],
  ]
  for (const [name, act, why] of cases) failed(await run(afterHello(act)), why, name)
})

test('the JSON: nesting 17 and 32,000 deep, fractions, exponents, leading zeros, a key twice, and envelopes without their parts', { skip, timeout: 90_000 }, async () => {
  const sealed = (text: string): string => `{"n":1,"body":${text},"mac":"${'0'.repeat(64)}"}`
  const cases: [string, string, RegExp][] = [
    ['17 deep', sealed(`${'['.repeat(17)}${']'.repeat(17)}`), /nested too deep/],
    ['32,000 deep', sealed(`${'['.repeat(32_000)}${']'.repeat(32_000)}`), /nested too deep/],
    ['10,000 deep objects', sealed(`${'{"a":'.repeat(10_000)}1${'}'.repeat(10_000)}`), /nested too deep/],
    ['n with a fraction', `{"n":1.0,"body":{"t":"ready"},"mac":"${'0'.repeat(64)}"}`, /fraction or an exponent/],
    ['n with an exponent', `{"n":1e0,"body":{"t":"ready"},"mac":"${'0'.repeat(64)}"}`, /fraction or an exponent/],
    ['n with a leading zero', `{"n":01,"body":{"t":"ready"},"mac":"${'0'.repeat(64)}"}`, /not a whole number/],
    ['n of 17 digits', `{"n":10000000000000000,"body":{"t":"ready"},"mac":"${'0'.repeat(64)}"}`, /not a whole number/],
    ['n as text', `{"n":"1","body":{"t":"ready"},"mac":"${'0'.repeat(64)}"}`, /without n, body and mac/],
    ['a key twice', `{"n":1,"n":2,"body":{"t":"ready"},"mac":"${'0'.repeat(64)}"}`, /a key twice/],
    ['a key twice in the body', sealed('{"t":"ready","t":"ready"}'), /a key twice/],
    ['a \\u escape outside ASCII', sealed('{"t":"re\\u00e1dy"}'), /outside ASCII/],
    ['a surrogate escape', sealed('{"t":"\\ud83d\\ude00"}'), /outside ASCII/],
    ['a raw control character', sealed('{"t":"re\u0001ady"}'), /unterminated string/],
    ['text after the value', `${sealed('{"t":"ready"}')} x`, /text after the value/],
    ['a BOM', `﻿${sealed('{"t":"ready"}')}`, /unexpected character/],
    ['empty text', '', /ended early/],
    ['an array envelope', '[1,2,3]', /without n, body and mac/],
    ['no mac', '{"n":1,"body":{"t":"ready"}}', /without n, body and mac/],
    ['no body', `{"n":1,"mac":"${'0'.repeat(64)}"}`, /without n, body and mac/],
    ['a body that is a number', `{"n":1,"body":7,"mac":"${mac(1, 7)}"}`, /expected 'ready', the host sent None/],
    ['a body that is a list', `{"n":1,"body":[],"mac":"${mac(1, [])}"}`, /expected 'ready', the host sent None/],
  ]
  for (const [name, wire, why] of cases) failed(await run(afterHello((c) => c.text(wire))), why, name)
})

test('the seal: a wrong mac, a replay, n = 0, n = 2^53, a seal under another key', { skip, timeout: 60_000 }, async () => {
  const body = { t: 'ready', digest: DIGEST }
  const cases: [string, Hostile, RegExp][] = [
    ['a wrong mac', afterHello((c) => c.send(body, 1, '0'.repeat(64))), /seal is not the session token's/],
    ['a mac of the wrong length', afterHello((c) => c.send(body, 1, 'ab')), /seal is not the session token's/],
    ['a mac in upper case', afterHello((c) => c.send(body, 1, mac(1, body).toUpperCase())), /seal is not the session token's/],
    ['sealed under another token', afterHello((c) => c.send(body, 1, createHmac('sha256', `${TOKEN}x`).update(canonical({ n: 1, body })).digest('hex'))), /seal is not the session token's/],
    ['sealed as n = 2 but sent as n = 1', afterHello((c) => c.send(body, 1, mac(2, body))), /seal is not the session token's/],
    ['n = 0', afterHello((c) => c.send(body, 0)), /replayed frame/],
    ['n = -1', afterHello((c) => c.send(body, -1)), /replayed frame/],
    ['n = -0', afterHello((c) => c.text(`{"n":-0,"body":${JSON.stringify(body)},"mac":"${mac(0, body)}"}`)), /replayed frame/],
    ['the ready replayed', {
      script: async (c) => {
        const seal = await greetAndTakeLedger(c)
        c.send({ t: 'verified', head: seal.head, count: seal.count, weights: seal.weights }, 1)
      },
    }, /replayed frame/],
    ['n going back', {
      script: async (c) => {
        await c.next()
        c.send(body, 5)
        let m = await c.next()
        while (m.t === 'entries') m = await c.next()
        c.send({ t: 'verified', head: m.head, count: m.count, weights: m.weights }, 4)
      },
    }, /replayed frame/],
    // n = 2^53 is taken (every envelope number up to 16 digits is), so what follows must still be judged on its own.
    ['n = 2^53, then a verified for another ledger', {
      script: async (c) => {
        await c.next()
        c.send(body, 2 ** 53)
        let m = await c.next()
        while (m.t === 'entries') m = await c.next()
        c.send({ t: 'verified', head: sha256('another'), count: m.count, weights: m.weights }, 2 ** 53 + 2)
      },
    }, /verified another ledger/],
  ]
  for (const [name, h, why] of cases) failed(await run(h), why, name)
})

test('the protocol: a ready for another configuration, a verified for another ledger, a refused, and the wrong kind', { skip, timeout: 60_000 }, async () => {
  const verifiedWith = (edit: (seal: Record<string, unknown>) => Record<string, unknown>): Hostile => ({
    script: async (c) => {
      const seal = await greetAndTakeLedger(c)
      c.send(edit({ t: 'verified', head: seal.head, count: seal.count, weights: seal.weights }))
    },
  })
  const cases: [string, Hostile, RegExp][] = [
    ['a ready naming another digest', afterHello((c) => c.send({ t: 'ready', digest: sha256('other') })), /names another configuration/],
    ['a ready with no digest', afterHello((c) => c.send({ t: 'ready' })), /names another configuration/],
    ['a ready whose digest is upper case', afterHello((c) => c.send({ t: 'ready', digest: DIGEST.toUpperCase() })), /names another configuration/],
    ['a refused instead of ready', afterHello((c) => c.send({ t: 'refused', reason: 'no' })), /^FAIL: refused: no$/m],
    ['a refused with no reason', afterHello((c) => c.send({ t: 'refused' })), /^FAIL: refused: \?$/m],
    ['a verified instead of ready', afterHello((c) => c.send({ t: 'verified', head: DIGEST, count: 0, weights: DIGEST })), /expected 'ready', the host sent Some\("verified"\)/],
    ['a message with no t', afterHello((c) => c.send({ digest: DIGEST })), /expected 'ready', the host sent None/],
    ['a message whose t is a number', afterHello((c) => c.send({ t: 1 })), /expected 'ready', the host sent None/],
    ['a verified for another head', verifiedWith((v) => ({ ...v, head: sha256('another head') })), /verified another ledger/],
    ['a verified for other weights', verifiedWith((v) => ({ ...v, weights: sha256('other weights') })), /verified another ledger/],
    ['a verified with no head', verifiedWith((v) => ({ t: v.t, count: v.count, weights: v.weights })), /verified another ledger/],
    ['a verified whose head is a number', verifiedWith((v) => ({ ...v, head: 7 })), /verified another ledger/],
    ['a second ready instead of the verdict', verifiedWith(() => ({ t: 'ready', digest: DIGEST })), /expected 'verified', the host sent Some\("ready"\)/],
    ['a refused after the seal', verifiedWith(() => ({ t: 'refused', reason: 'entry 9: the chain breaks here' })), /refused: entry 9: the chain breaks here/],
    ['a none instead of the verdict', verifiedWith(() => ({ t: 'none' })), /expected 'verified'/],
    ['the connection dropped after the seal', { script: async (c) => { await greetAndTakeLedger(c); c.socket.destroy() } }, /closed the connection|read:/],
  ]
  for (const [name, h, why] of cases) failed(await run(h), why, name)
})

test('the fetch: weights of 65537, 0 and -1, a sentry, a duplicate, descending, past the pool, 200,000 of them, an end that disagrees', { skip, timeout: 120_000 }, async () => {
  type Seal = Record<string, unknown>
  const weights = (list: [number, number][]): Record<string, unknown> => ({ t: 'weights', list })
  /** An `end` under the honest digest unless told otherwise. */
  const end = (seal: Seal, pairs: number, digest = seal.weights): Record<string, unknown> => ({ t: 'end', head: seal.head, count: seal.count, weights: digest, pairs })
  const cases: [string, (c: Conn, seal: Seal) => Promise<void> | void, RegExp][] = [
    ['a weight of 65537', (c, s) => { c.send(weights([[0, 65537]])); c.send(end(s, 1)) }, /weight 0 \(65537\) is outside 1\.\.65536/],
    ['a weight of 65536 (the most a reward is), under the honest digest', (c, s) => { c.send(weights([[0, 65536]])); c.send(end(s, 1)) }, /not the ones the host sealed/],
    ['a weight of 0', (c, s) => { c.send(weights([[0, 0]])); c.send(end(s, 1)) }, /weight 0 \(0\) is outside/],
    ['a weight of -1', (c, s) => { c.send(weights([[0, -1]])); c.send(end(s, 1)) }, /weight 0 \(-1\) is outside/],
    ['a weight of 2^31', (c, s) => { c.send(weights([[0, 2 ** 31]])); c.send(end(s, 1)) }, /is outside 1\.\.65536/],
    ['a weight of -2^31 - 1', (c, s) => { c.send(weights([[0, -(2 ** 31) - 1]])); c.send(end(s, 1)) }, /is outside 1\.\.65536/],
    ["a sentry's weight", (c, s) => { c.send(weights([[SENTRY_ROW, 100]])); c.send(end(s, 1)) }, /never declared with learn/],
    ["the tutor's weight", (c, s) => { c.send(weights([[POOL - 1, 100]])); c.send(end(s, 1)) }, /never declared with learn/],
    ['a duplicate index', (c, s) => { c.send(weights([[5, 100], [5, 100]])); c.send(end(s, 2)) }, /out of order/],
    ['a descending index', (c, s) => { c.send(weights([[6, 100], [5, 100]])); c.send(end(s, 2)) }, /out of order/],
    ['descending across two messages', (c, s) => { c.send(weights([[6, 100]])); c.send(weights([[5, 100]])); c.send(end(s, 2)) }, /out of order/],
    ['an index past the pool', (c, s) => { c.send(weights([[POOL, 100]])); c.send(end(s, 1)) }, /outside the pool/],
    ['a negative index', (c, s) => { c.send(weights([[-1, 100]])); c.send(end(s, 1)) }, /out of order or outside/],
    ['an index of 2^53', (c, s) => { c.send(weights([[2 ** 53, 100]])); c.send(end(s, 1)) }, /outside the pool/],
    ['a pair of three', (c, s) => { c.send({ t: 'weights', list: [[1, 100, 3]] }); c.send(end(s, 1)) }, /not a pair/],
    ['a pair of text', (c, s) => { c.send({ t: 'weights', list: [['1', '100']] }); c.send(end(s, 1)) }, /not two whole numbers/],
    ['a list that is not a list', (c, s) => { c.send({ t: 'weights', list: 7 }); c.send(end(s, 1)) }, /without a list/],
    ['an end that counts one too many', (c, s) => { c.send(weights([[0, 100], [1, 100]])); c.send(end(s, 3)) }, /does not count the weights/],
    ['an end that counts one too few', (c, s) => { c.send(weights([[0, 100], [1, 100]])); c.send(end(s, 1)) }, /does not count the weights/],
    ['an end with no count', (c, s) => { c.send(weights([[0, 100]])); c.send({ t: 'end', head: s.head, count: s.count, weights: s.weights }) }, /does not count the weights/],
    ['an end with no digest', (c, s) => { c.send(weights([[0, 100]])); c.send({ t: 'end', head: s.head, count: s.count, pairs: 1 }) }, /without the weights' digest/],
    ['an end under another digest', (c, s) => { c.send(weights([[0, 100]])); c.send(end(s, 1, sha256('other'))) }, /sealed under another digest/],
    ['an end whose digest is upper case', (c, s) => { c.send(weights([[0, 100]])); c.send(end(s, 1, String(s.weights).toUpperCase())) }, /sealed under another digest/],
    ['none', (c) => c.send({ t: 'none' }), /holds no verified weights/],
    ['a ready during the fetch', (c) => c.send({ t: 'ready', digest: DIGEST }), /the host sent Some\("ready"\) during a fetch/],
    ['a verified during the fetch', (c, s) => c.send({ t: 'verified', head: s.head, count: s.count, weights: s.weights }), /during a fetch/],
    ['a refused during the fetch', (c) => c.send({ t: 'refused', reason: 'fetch before hello' }), /refused: fetch before hello/],
    ['200,000 pairs', (c, s) => {
      for (let from = 0; from < 200_000; from += 5000) c.send(weights(Array.from({ length: 5000 }, (_, i) => [from + i, 100])))
      c.send(end(s, 200_000))
    }, /never declared with learn|outside the pool/],
  ]
  for (const [name, act, why] of cases) failed(await run(atFetch(act), 20_000), why, name, true)
})

test('a seal that holds and weights that are the fold: the hostile host can still only earn a verdict by telling the truth', { skip, timeout: 30_000 }, async () => {
  // Honest at every step, except that the weights it shares are the bridge's own seal said: the one run that may
  // print `fleet sync`. (That the bridge's fold is the host's is the live smoke's and the Rust tests' to prove.)
  let sealed: Record<string, unknown> | null = null
  const o = await run({
    script: async (c, session) => {
      if (session === 1) {
        sealed = await greetAndTakeLedger(c)
        c.send({ t: 'verified', head: sealed.head, count: sealed.count, weights: sealed.weights })
        return
      }
      await c.next()
      ready(c)
      await c.next()
      // The bridge's own weights are not known here; sharing nothing under its digest is a lie it must catch.
      c.send({ t: 'end', head: sealed!.head, count: sealed!.count, weights: sealed!.weights, pairs: 0 })
    },
  })
  failed(o, /not the ones the host sealed/, 'an empty set under the honest digest', true)
  assert.equal(o.sessions, 2)
})

// ---------------------------------------------------------------------------------------------------
// The audit's findings: these fail until the bridge takes the fix.

test('REGRESSION (finding: no per-message deadline): a ping flood, a pong flood, bytes dribbled one at a time', {
  skip: skip || 'CONFIRMED major, fails until the fix lands: wire.rs Ws has only a per-read timeout (set_read_timeout, wire.rs:442), which resets on every read, so a host that sends a ping (answered at wire.rs:539), a pong, or one byte of a frame every <20 s holds the bridge forever. Verified: this case hung the bridge past 12 s (killed). The fix is an overall deadline in Ws::recv/Sealed::recv (an Instant at the first read, checked before each fill); un-skip once wire.rs carries it.',
  timeout: 120_000,
}, async () => {
  // The bridge answers every ping and ignores every pong without bound, and its read timeout starts over at each
  // read: a host that sends one every second (or one byte of a frame every few seconds) holds it forever.
  const flood = (opcode: number): Hostile => afterHello(async (c) => {
    for (let i = 0; i < 400 && !c.socket.destroyed; i++) {
      c.raw(writeFrame(opcode, Buffer.from(`p${i}`)))
      await sleep(25)
    }
  })
  const payload = Buffer.from(JSON.stringify({ n: 1, body: { t: 'ready' }, mac: '0'.repeat(64) }))
  const dribble = afterHello(async (c) => {
    const frame = writeFrame(OP.text, payload)
    for (let i = 0; i < frame.length && !c.socket.destroyed; i++) {
      c.raw(frame.subarray(i, i + 1))
      await sleep(300)
    }
  })
  for (const [name, h, why] of [['a ping flood', flood(OP.ping), /timed out|deadline|too many/], ['a pong flood', flood(OP.pong), /timed out|deadline|too many/], ['bytes dribbled', dribble, /timed out|deadline/]] as const) {
    failed(await run(h, 12_000), why, name)
  }
})

test('REGRESSION (finding: a fetch is not bounded before its end): the bridge refuses more pairs than the pool holds while they are still arriving', {
  skip: skip || 'CONFIRMED major, fails until the fix lands: bridge.rs fetch() accumulates every weights pair into `got` (bridge.rs:92, got.push at :102) with no bound; nothing is checked until the `end` (indices and range are adopt()\'s, after the loop). A host that streams weights and never sends `end` grows the bridge\'s memory without limit, stopped only by the per-read timeout. Verified: 1,000,000 pairs (30x the 32,768 pool) streamed and the bridge kept taking them (killed at 10 s). The fix is a cap in the weights branch (got.len() past d.capacity*d.stations is refused at once); un-skip once bridge.rs carries it.',
  timeout: 60_000,
}, async () => {
  // 1,000,000 pairs is thirty times the pool; without the bound the bridge keeps every one until an `end` that never
  // comes, and only the 20 s read timeout ends it.
  let streamed = 0
  const o = await run(atFetch(async (c) => {
    for (let from = 0; from < 1_000_000 && !c.socket.destroyed; from += 5000) {
      c.send({ t: 'weights', list: Array.from({ length: 5000 }, (_, i) => [from + i, 100]) })
      streamed += 5000
      if (from % 100_000 === 0) await sleep(1)
    }
  }), 10_000)
  failed(o, /outside the pool|more weights than the pool/, 'a fetch past the pool', true)
  assert.ok(streamed >= POOL, `the host streamed past the pool (${streamed} pairs)`)
})

test("REGRESSION (finding: the host's text reaches the terminal raw): a refused reason and a close reason carrying escape sequences are escaped before they are printed", {
  skip: skip || "CONFIRMED major, fails until the fix lands: the host's text reaches the operator's terminal unescaped. main.rs:287 prints `FAIL: {e}` raw; bridge.rs:46/116 build that string from the host's `refused` reason and wire.rs:635 from the close reason, none escaped. The TS host escapes every untrusted string before it logs it (replication.node.ts loggable); the Rust bridge has no equal. Verified: the bytes \u001b[2J \u001b]0;owned\u0007 \u009b31m reached stderr intact (a terminal could act on them). The fix is a loggable() equivalent applied to host text before any eprintln!/return Err that carries it; un-skip once wire.rs/bridge.rs carry it.",
  timeout: 30_000,
}, async () => {
  const esc = '\u001b[2J\u001b]0;owned\u0007\u009b31m'
  const cases: [string, Hostile][] = [
    ['a refused reason', afterHello((c) => c.send({ t: 'refused', reason: `${esc}not the fold` }))],
    ['a close reason', afterHello((c) => c.raw(writeFrame(OP.close, Buffer.concat([Buffer.from([0x0f, 0xa8]), Buffer.from(esc, 'utf8')]))))],
    ['a kind the bridge quotes', afterHello((c) => c.send({ t: `${esc}ready` }))],
  ]
  for (const [name, h] of cases) {
    const o = await run(h)
    failed(o, /FAIL/, name)
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(o.stderr, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/, `${name}: a control character the host sent reached the terminal: ${JSON.stringify(o.stderr.slice(0, 200))}`)
  }
})

test('a stall after the hello ends with the read timeout', { skip, timeout: 60_000 }, async () => {
  const o = await run(afterHello(() => {}), 40_000)
  failed(o, /read: .*(timed out|Resource temporarily unavailable)/, 'a stall')
  // wire.rs sets a 20 s read timeout: the bridge is held about that long, and no longer.
  assert.ok(o.ms > 15_000 && o.ms < 35_000, `the stall ended after ${o.ms.toFixed(0)} ms`)
})
