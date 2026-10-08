// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the property-based fuzzing of the Node host (replication.node.ts) over real loopback
 * sockets, seeded and replayable (02_Define_The_Rules/property.ts): hundreds of hostile connections at once, each a
 * random script of what an attacker can do to a socket (random bytes before or after the upgrade, a garbage or a
 * truncated upgrade, a good token followed by frames that are random, unmasked, oversized, of unknown opcodes, a
 * sealed message mutated, frames split at random byte boundaries or many in one write, then an end, a reset or a
 * silence), two connections racing under one player's token, and a client that dribbles its headers. Through all of it
 * the host never throws (an unhandled error would end this process), never holds a refused or silent socket past its
 * timeouts, lets every connection go, keeps one connection per player, and still welcomes an honest client and keeps
 * its walk afterwards.
 * What breaks if it is removed? A byte sequence nobody tried could bring the room down for everyone in it.
 */
import assert from 'node:assert/strict'
import { connect, type Socket } from 'node:net'
import { test } from 'node:test'
import { gen, mutate, type Gen } from '../02_Define_The_Rules/property.ts'
import { RUN } from '../07_Execute_Actions/simProtocol.ts'
import { planeAuthority, planeStep } from './plane.node.ts'
import { AUTH_PREFIX, openServerFrame, PROTOCOL_VERSION, sealMessage, SUBPROTOCOL, type ClientMessage } from './replication.ts'
import { OP, startHost, type Host } from './replication.node.ts'

const SECRET = 'host-fuzz-secret-sixteen'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  for (let t = 0; t < ms; t += 10) {
    if (cond()) return
    await sleep(10)
  }
  assert.ok(cond(), `still waiting: ${what}`)
}

/** A client frame, masked, of any length class; `masked` false sends it bare (the host must refuse it). */
function frame(opcode: number, payload: Buffer, masked = true, fin = true): Buffer {
  const len = payload.length
  const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | len])
    : len < 65536 ? Buffer.from([(fin ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | 126, len >> 8, len & 0xff])
      : (() => { const b = Buffer.alloc(10); b[0] = (fin ? 0x80 : 0) | opcode; b[1] = (masked ? 0x80 : 0) | 127; b.writeBigUInt64BE(BigInt(len), 2); return b })()
  if (!masked) return Buffer.concat([head, payload])
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d])
  return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]))])
}

const upgrade = (host: Host, protocol: string | null): string =>
  `GET / HTTP/1.1\r\nHost: ${host.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${protocol === null ? '' : `Sec-WebSocket-Protocol: ${protocol}\r\n`}\r\n`

const MESSAGES: readonly unknown[] = [
  { t: 'join', v: PROTOCOL_VERSION, token: '', name: 'Eve', world: 'plane' },
  { t: 'input', seq: 1, ack: 0, fix: 1, mode: 'foot', segs: [[0, RUN, 6]], heading: 0, claim: { x: 0, y: 0.92, z: 0.52 } },
  { t: 'input', seq: 2, ack: 0, fix: 1, mode: 'drive', segs: [[1, 0, 0, 0, 30]], heading: 0, claim: { x: 0, y: 0.7, z: 5 }, door: { enter: { car: 1, state: { x: 0, y: 0.7, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 } } } },
  { t: 'chat', seq: 1, text: 'hello' },
  { t: 'ping', seq: 2, kind: 'go', x: 0, y: 0, z: 0 },
  { t: 'ack', ack: 0 },
]

/** One hostile connection's script, played out; resolves when its socket is gone. */
async function hostile(host: Host, g: Gen, id: number): Promise<void> {
  const token = host.token(`eve${id % 7}`)
  const socket: Socket = connect(host.port, host.host)
  const gone = new Promise<void>((r) => socket.once('close', () => r()))
  socket.on('error', () => {})
  socket.on('data', () => {})
  await new Promise<void>((r) => socket.once('connect', () => r()))
  const write = (b: Buffer | string): void => { if (!socket.destroyed) socket.write(b) }
  /** Bytes split at random boundaries, a few writes apart, or all at once. */
  const dribble = async (b: Buffer): Promise<void> => {
    let i = 0
    while (i < b.length && !socket.destroyed) {
      const n = g.bool(0.3) ? b.length - i : g.int(1, Math.max(1, Math.min(64, b.length - i)))
      write(b.subarray(i, i + n))
      i += n
      if (g.bool(0.2)) await sleep(g.int(0, 5))
    }
  }
  const opening = g.int(0, 9)
  if (opening === 0) await dribble(Buffer.from(Array.from({ length: g.int(1, 3000) }, () => g.int(0, 255))))
  else if (opening === 1) await dribble(Buffer.from(upgrade(host, `${SUBPROTOCOL}, ${AUTH_PREFIX}forged.${id}`)))
  else if (opening === 2) await dribble(Buffer.from(upgrade(host, null).slice(0, g.int(0, 120))))
  else await dribble(Buffer.from(upgrade(host, `${SUBPROTOCOL}, ${AUTH_PREFIX}${token}`)))
  await sleep(g.int(0, 20))
  let n = 0
  for (let k = g.int(0, 25); k > 0 && !socket.destroyed; k--) {
    const roll = g.next()
    let b: Buffer
    if (roll < 0.3) {
      const msg = mutate(g.pick(MESSAGES), g, g.int(0, 2)) as { t?: string; token?: string }
      if (msg.t === 'join' && g.bool()) msg.token = token
      // A seal an honest client could make, or (for what it refuses to seal: a number that is not one) a frame forged by hand.
      let text: string
      try {
        text = sealMessage(msg as ClientMessage, ++n, token)
      } catch {
        text = JSON.stringify({ n, body: msg, mac: '0'.repeat(64) })
      }
      b = frame(OP.text, Buffer.from(text))
    } else if (roll < 0.45) b = frame(g.pick([OP.text, OP.binary, OP.ping, OP.pong, 3, 11, OP.continuation]), Buffer.from(Array.from({ length: g.int(0, 200) }, () => g.int(0, 255))), g.bool(0.9), g.bool(0.9))
    else if (roll < 0.55) b = frame(OP.text, Buffer.alloc(g.pick([4097, 70_000])), true)
    else if (roll < 0.65) b = frame(OP.text, Buffer.from('{"n":1}'), false)
    else if (roll < 0.8) b = frame(OP.ping, Buffer.from('p'))
    else b = Buffer.from(Array.from({ length: g.int(1, 400) }, () => g.int(0, 255)))
    await dribble(b)
  }
  const ending = g.int(0, 3)
  if (ending === 0) socket.resetAndDestroy()
  else if (ending === 1) socket.end()
  else if (ending === 2) write(frame(OP.close, Buffer.from([0x03, 0xe8])))
  // 3: silence; the host's timeouts (the join timeout, the header timeout) must let it go. The test ends it if not.
  await Promise.race([gone, sleep(12_000)])
  if (!socket.destroyed) socket.destroy()
}

test('hundreds of hostile connections at once: the host never throws, lets every socket go, and still serves an honest player', { timeout: 120_000 }, async () => {
  const clock = { now: Date.now() }
  const host = await startHost({ secret: SECRET, tickHz: 50, authority: planeAuthority('plane'), headersTimeoutMs: 1000, now: () => clock.now })
  // The join timeout runs on the injected clock: it moves with real time, five seconds a second, so a silent socket is let go soon.
  const ticker = setInterval(() => { clock.now += 250 }, 50)
  try {
    for (const round of [0xdead, 0xbeef, 0xfeed]) {
      const g = gen(round)
      await Promise.all(Array.from({ length: 120 }, (_, i) => hostile(host, gen(g.int(0, 2 ** 31)), i)))
      await until(() => host.connections() === 0 && host.room.peers.size === 0, `round ${round.toString(16)}: every socket let go (${host.connections()} open)`)
    }
    // One player, one connection: two upgrades racing under one token leave one live connection.
    const race = await Promise.all([0, 1].map(async () => {
      const ws = new WebSocket(host.url, [SUBPROTOCOL, AUTH_PREFIX + host.token('racer')])
      const closed = new Promise<number>((r) => { ws.onclose = (ev) => r(ev.code) })
      await new Promise<void>((r) => { ws.onopen = () => r(); ws.onerror = () => r() })
      return { ws, closed }
    }))
    await until(() => host.connections() === 1, 'one connection for the racer')
    assert.equal(await Promise.race([...race.map((r) => r.closed), sleep(2000).then(() => -1)]), 4010)
    for (const r of race) r.ws.close()
    await until(() => host.connections() === 0, 'the racer gone')
    // A client that dribbles its headers is dropped by the parser's timeout.
    const slow = connect(host.port, host.host)
    slow.on('error', () => {})
    await new Promise<void>((r) => slow.once('connect', () => r()))
    slow.write('GET / HTTP/1.1\r\nHost: x\r\n')
    // (The parser's check runs on its own interval: a loaded machine may take a few of them.)
    const dropped = await Promise.race([new Promise<boolean>((r) => slow.once('close', () => r(true))), sleep(10_000).then(() => false)])
    assert.ok(dropped, 'a slow-header client is let go')
    // An honest player after all of it: welcomed, its walk kept.
    const token = host.token('ada')
    const ws = new WebSocket(host.url, [SUBPROTOCOL, AUTH_PREFIX + token])
    const got: { t: string; you?: { x: number; z: number } }[] = []
    let received = 0
    ws.onmessage = (ev) => {
      const r = openServerFrame(String(ev.data), token, received)
      assert.ok(r.ok)
      received = r.n
      got.push(r.msg as never)
    }
    await new Promise<void>((r) => { ws.onopen = () => r() })
    ws.send(sealMessage({ t: 'join', v: PROTOCOL_VERSION, token, name: 'Ada', world: 'plane' }, 1, token))
    await until(() => got.some((m) => m.t === 'welcome'), 'the welcome')
    const you = got.find((m) => m.t === 'welcome')!.you!
    const claim = planeStep(you, [[0, RUN, 6]])
    ws.send(sealMessage({ t: 'input', seq: 1, ack: 0, fix: 1, mode: 'foot', segs: [[0, RUN, 6]], heading: 0, claim }, 2, token))
    await until(() => [...host.room.peers.values()].some((p) => p.seq === 1 && p.z === claim.z), 'the walk kept')
    assert.ok(!got.some((m) => m.t === 'correct'))
    ws.close()
  } finally {
    clearInterval(ticker)
    await host.close()
  }
})
