/**
 * Why does this file exist? It proves the Node host (replication.node.ts) over a real loopback socket with Node 22's
 * own WebSocket: tokens are signed with an expiry and refuse tampering; frames are read by the RFC 6455 rules (masked
 * from the client, bounded, control frames small) and written unmasked; a join with a good token is welcomed and a bad
 * one is refused silently; valid inputs move the authoritative pose that the next snapshot carries to every peer;
 * malformed and over-rate frames are counted until the peer is removed with a close code; a plain HTTP request is
 * told to upgrade; and the host closes cleanly. Every wait is for the host to observe the event, never a fixed sleep.
 * What breaks if it is removed? The door could stop refusing what the core refuses, or a frame rule could drift.
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { request } from 'node:http'
import { connect, type Socket } from 'node:net'
import { canonical } from '../02_Define_The_Rules/integrity.ts'
import { LIMITS, openServerFrame, PROTOCOL_VERSION, sealMessage, type ClientMessage, type ServerMessage } from './replication.ts'
import { acceptKey, closePayload, mintToken, OP, readFrame, startHost, verifyToken, writeFrame, type Host } from './replication.node.ts'

const SECRET = 'test-secret'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Polls until `cond` holds, at most 3 s: the host observes sockets on its own schedule, so the test waits for it rather than guessing. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let t = 0; t < 3000; t += 10) {
    if (cond()) return
    await sleep(10)
  }
  assert.ok(cond(), `still waiting: ${what}`)
}

/**
 * A frame sealed the way the page seals one (replication.ts sealMessage) but with node:crypto: the host may sign with
 * either, so every frame this file sends proves the two agree bit for bit. A join is sealed under the token it carries.
 */
function sealWithNode(msg: unknown, n: number, key: string): string {
  const body: unknown = JSON.parse(JSON.stringify(msg))
  const mac = createHmac('sha256', key).update(canonical({ n, body }), 'utf8').digest('hex')
  const wire = JSON.stringify({ n, body, mac })
  assert.equal(wire, sealMessage(body as ClientMessage, n, key), 'node:crypto and integrity.ts seal alike')
  return wire
}

/** A client over Node's global WebSocket that records every message the host sends, opened and checked by the core. */
interface Client {
  ws: WebSocket
  /** The session token this client joins with and reads the host under. */
  token: string
  got: ServerMessage[]
  closed: Promise<{ code: number; reason: string }>
  /** `msg` sealed as the next envelope (a string goes as it is). */
  seal(msg: unknown): string
  send(msg: unknown): void
  /** The next message of kind `t` after `from` entries, within 3 s. */
  next<T extends ServerMessage['t']>(t: T, from?: number): Promise<Extract<ServerMessage, { t: T }>>
}

async function open(host: Host, subject = 'tester'): Promise<Client> {
  const ws = new WebSocket(host.url)
  const token = host.token(subject)
  const got: ServerMessage[] = []
  let received = 0
  let sent = 0
  const closed = new Promise<{ code: number; reason: string }>((r) => { ws.onclose = (ev) => r({ code: ev.code, reason: ev.reason }) })
  ws.onmessage = (ev) => {
    const read = openServerFrame(String(ev.data), token, received)
    assert.ok(read.ok, `the host sent something the core refuses: ${String(ev.data)}`)
    received = read.n
    got.push(read.msg)
  }
  await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error('socket error')) })
  const seal = (msg: unknown): string => {
    if (typeof msg === 'string') return msg
    const m = msg as { t?: unknown; token?: unknown }
    return sealWithNode(msg, ++sent, m.t === 'join' && typeof m.token === 'string' ? m.token : token)
  }
  const c: Client = {
    ws, token, got, closed, seal,
    send: (msg) => ws.send(seal(msg)),
    next: async (t, from = 0) => {
      let found: ServerMessage | undefined
      await until(() => { found = got.slice(from).find((m) => m.t === t); return found !== undefined }, `a '${t}' message`)
      return found as never
    },
  }
  return c
}

// ---------------------------------------------------------------- tokens and frames

test('tokens: signed with an expiry; the subject comes back only for a good, unexpired, untampered token under the same secret', () => {
  const t = mintToken(SECRET, 'Ada', 10_000)
  assert.equal(verifyToken(SECRET, t, 9_999), 'Ada')
  assert.equal(verifyToken(SECRET, t, 10_000), null, 'expired at the instant')
  assert.equal(verifyToken('other', t, 0), null, 'another secret')
  const [subject, expires, mac] = t.split('.')
  assert.equal(verifyToken(SECRET, `${subject}.${Number(expires) + 1}.${mac}`, 0), null, 'a longer life is not signed')
  assert.equal(verifyToken(SECRET, `${Buffer.from('Bob').toString('base64url')}.${expires}.${mac}`, 0), null, 'another subject is not signed')
  assert.equal(verifyToken(SECRET, `${subject}.${expires}.${mac.slice(0, -1)}`, 0), null, 'a short signature')
  assert.equal(verifyToken(SECRET, `${subject}.${expires}`, 0), null)
  assert.equal(verifyToken(SECRET, '', 0), null)
  assert.equal(verifyToken(SECRET, 42, 0), null)
  assert.equal(verifyToken(SECRET, 'x'.repeat(LIMITS.token + 1), 0), null)
  assert.throws(() => mintToken(SECRET, 'bad\nname', 1), /subject/)
  assert.throws(() => mintToken(SECRET, 'Ada', 1.5), /expiresAt/)
  assert.ok(t.length <= LIMITS.token)
})

test('frames: masked client frames of every length class are read, unmasked ones and fragments refused, the bound enforced; host frames are unmasked', () => {
  const masked = (opcode: number, payload: Buffer, fin = true): Buffer => {
    const mask = Buffer.from([1, 2, 3, 4])
    const len = payload.length
    const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]) : len < 65536 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, len >> 8, len & 0xff]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return b })()
    return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]))])
  }
  for (const n of [0, 5, 125, 126, 300, 4096]) {
    const text = Buffer.from('x'.repeat(n))
    const r = readFrame(Buffer.concat([masked(OP.text, text), Buffer.from([9, 9])]))
    assert.equal(r.kind, 'frame', `${n} bytes`)
    if (r.kind === 'frame') {
      assert.equal(r.opcode, OP.text)
      assert.equal(r.payload.toString(), text.toString())
      assert.equal(r.used, masked(OP.text, text).length, 'the tail is left for the next frame')
    }
  }
  assert.deepEqual(readFrame(Buffer.alloc(0)), { kind: 'more' })
  assert.deepEqual(readFrame(masked(OP.text, Buffer.from('hello')).subarray(0, 8)), { kind: 'more' })
  assert.deepEqual(readFrame(writeFrame(OP.text, Buffer.from('hi'))), { kind: 'bad', code: 1002, reason: 'unmasked client frame' })
  assert.deepEqual(readFrame(masked(OP.text, Buffer.from('hi'), false)), { kind: 'bad', code: 1003, reason: 'fragmented frame' })
  assert.deepEqual(readFrame(masked(OP.continuation, Buffer.from('hi'))), { kind: 'bad', code: 1003, reason: 'fragmented frame' })
  assert.deepEqual(readFrame(masked(OP.text, Buffer.alloc(LIMITS.message + 1))), { kind: 'bad', code: 1009, reason: 'frame too big' })
  assert.deepEqual(readFrame(masked(OP.text, Buffer.alloc(70_000))), { kind: 'bad', code: 1009, reason: 'frame too big' })
  assert.deepEqual(readFrame(masked(OP.ping, Buffer.alloc(126))), { kind: 'bad', code: 1002, reason: 'control frame too big' })
  assert.deepEqual(readFrame(masked(3, Buffer.alloc(1))), { kind: 'bad', code: 1002, reason: 'opcode' })
  const rsv = masked(OP.text, Buffer.from('a'))
  rsv[0] |= 0x40
  assert.deepEqual(readFrame(rsv), { kind: 'bad', code: 1002, reason: 'reserved bits' })
  const w = writeFrame(OP.text, Buffer.from('x'.repeat(300)))
  assert.equal(w[0], 0x81)
  assert.equal(w[1], 126, 'unmasked, 16-bit length')
  assert.equal(w.readUInt16BE(2), 300)
  assert.equal(writeFrame(OP.pong)[1], 0)
  const cp = closePayload(4008, 'repeated refusals')
  assert.equal(cp.readUInt16BE(0), 4008)
  assert.equal(cp.subarray(2).toString(), 'repeated refusals')
  assert.equal(closePayload(1000, 'x'.repeat(200)).length, 125)
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'the RFC\'s own example')
})

// ---------------------------------------------------------------- over a socket

test('a good token joins and is welcomed; inputs move the pose every snapshot carries; a second peer sees it, chat and pings are relayed; leaving is announced', async () => {
  const host = await startHost({ secret: SECRET, tickHz: 50 })
  try {
    const a = await open(host, 'Ada')
    await until(() => host.connections() === 1, 'the host to see the socket')
    a.send({ t: 'join', v: PROTOCOL_VERSION, token: a.token, name: 'Ada' })
    const welcome = await a.next('welcome')
    assert.equal(welcome.id, 1)
    assert.equal(welcome.tickHz, 50)
    assert.deepEqual(welcome.players, [])
    const s0 = await a.next('snapshot')
    assert.equal(s0.players.length, 1)
    assert.equal(s0.players[0].name, 'Ada')
    a.send({ t: 'input', seq: 1, ack: s0.tick, x: 2, z: 0, heading: 1 })
    await until(() => host.room.peers.get(1)?.seq === 1, 'the input applied')
    const s1 = await a.next('snapshot', a.got.length)
    assert.equal(s1.ack, 1)
    assert.ok(s1.players[0].x > 0 && s1.players[0].x < 1, `moved a little: ${s1.players[0].x}`)
    assert.equal(s1.players[0].heading, 1)
    assert.equal(s1.players[0].speed, 2)

    assert.equal((await a.next('joined')).player.name, 'Ada', 'a peer hears its own arrival, in room order')
    const mark = a.got.length
    const b = await open(host, 'Bob')
    b.send({ t: 'join', v: PROTOCOL_VERSION, token: b.token, name: 'Bob' })
    const wb = await b.next('welcome')
    assert.equal(wb.id, 2)
    assert.deepEqual(wb.players.map((p) => p.name), ['Ada'])
    const joined = await a.next('joined', mark)
    assert.equal(joined.player.name, 'Bob')
    const sb = await b.next('snapshot')
    assert.deepEqual(sb.players.map((p) => p.name).sort(), ['Ada', 'Bob'])

    a.send({ t: 'chat', seq: 1, text: 'Good morning, Bob' })
    const chat = await b.next('chat')
    assert.deepEqual([chat.from, chat.name, chat.text], [1, 'Ada', 'Good morning, Bob'])
    assert.ok(a.got.some((m) => m.t === 'chat'), 'the sender hears its own line, in room order')
    b.send({ t: 'ping', seq: 1, kind: 'gather', x: 1, y: 0, z: 2 })
    const ping = await a.next('ping')
    assert.deepEqual([ping.from, ping.kind, ping.x, ping.z], [2, 'gather', 1, 2])
    // An inadmissible line is dropped without a word: no relay, one refusal counted.
    const before = b.got.length
    a.send({ t: 'chat', seq: 2, text: 'shut up Bob' })
    await until(() => host.room.peers.get(1)?.refusals === 1, 'the refusal counted')
    assert.equal(b.got.slice(before).filter((m) => m.t === 'chat').length, 0)

    b.send({ t: 'leave' })
    const left = await a.next('left')
    assert.deepEqual([left.id, left.reason], [2, 'left'])
    assert.equal((await b.closed).code, 1000)
    await until(() => host.connections() === 1, 'the host to drop the socket')
    a.ws.close(1000, 'done')
    await until(() => host.connections() === 0 && host.room.peers.size === 0, 'the host to see the close')
  } finally {
    await host.close()
  }
})

test('a bad token is refused silently; malformed, binary, replayed, forged and over-rate frames count up to a kick with close code 4008', async () => {
  const host = await startHost({ secret: SECRET, tickHz: 50 })
  try {
    const bad = await open(host)
    bad.send({ t: 'join', v: PROTOCOL_VERSION, token: mintToken('wrong secret', 'x', Date.now() + 60_000), name: 'Ada' })
    await until(() => host.room.peers.get(1)?.refusals === 1, 'the bad token refused')
    bad.send({ t: 'join', v: PROTOCOL_VERSION, token: mintToken(SECRET, 'x', Date.now() - 1), name: 'Ada' })
    await until(() => host.room.peers.get(1)?.refusals === 2, 'the expired token refused')
    assert.equal(bad.got.length, 0, 'no welcome, no word')
    bad.send({ t: 'join', v: PROTOCOL_VERSION, token: bad.token, name: 'Ada' })
    await bad.next('welcome')
    const crafted: unknown[] = [
      '{not json',
      { t: 'input', seq: 1, ack: 0, x: NaN, z: 0, heading: 0 },
    ]
    for (const m of crafted) bad.send(m)
    bad.ws.send(new Uint8Array([1, 2, 3]))
    await until(() => host.room.peers.get(1)?.refusals === 2 + crafted.length + 1, 'every crafted frame refused')
    // A genuine input is applied once; the very same frame again is a replay, and one sealed under another token a forgery: refused, applying nothing.
    const genuine = bad.seal({ t: 'input', seq: 1, ack: 0, x: 1, z: 0, heading: 0 })
    bad.send(genuine)
    await until(() => host.room.peers.get(1)?.seq === 1, 'the genuine input applied')
    bad.send(genuine)
    bad.send(sealMessage({ t: 'input', seq: 2, ack: 0, x: 2, z: 0, heading: 0 }, 99, 'another token'))
    await until(() => host.room.peers.get(1)?.refusals === 2 + crafted.length + 1 + 2, 'the replay and the forgery refused')
    assert.equal(host.room.peers.get(1)?.seq, 1, 'nothing applied twice')
    assert.equal(host.room.peers.get(1)?.vx, 1, 'the forged velocity never landed')
    assert.equal(2 + crafted.length + 1 + 2, LIMITS.refusalsBeforeKick - 1)
    assert.equal(host.room.peers.get(1)?.joined, true, 'still in the room, one short of the limit')
    bad.send({ t: 'chat', seq: 1, text: 'you idiot' })
    const closed = await bad.closed
    assert.equal(closed.code, 4008)
    assert.equal(closed.reason, 'repeated refusals')
    await until(() => host.room.peers.size === 0, 'the peer gone from the room')

    // A flood of inputs past the burst is refused by the rate limit until the peer is removed.
    const flood = await open(host)
    flood.send({ t: 'join', v: PROTOCOL_VERSION, token: flood.token, name: 'Flood' })
    await flood.next('welcome')
    for (let seq = 1; seq <= LIMITS.inputBurst + LIMITS.refusalsBeforeKick; seq++) flood.send({ t: 'input', seq, ack: 0, x: 0, z: 0, heading: 0 })
    assert.equal((await flood.closed).code, 4008)
  } finally {
    await host.close()
  }
})

test('an unmasked frame or an over-size frame closes the socket with the RFC code; a peer that never joins is dropped by the join timeout rule', async () => {
  const clock = { now: 0 }
  const host = await startHost({ secret: SECRET, tickHz: 100, now: () => clock.now })
  const raw = (): Promise<{ socket: Socket; chunks: Buffer[] }> =>
    new Promise((resolve, reject) => {
      const socket = connect(host.port, host.host)
      const chunks: Buffer[] = []
      socket.on('data', (c: Buffer) => chunks.push(c))
      socket.on('error', reject)
      socket.on('connect', () => {
        socket.write(`GET / HTTP/1.1\r\nHost: ${host.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`)
      })
      const check = (): void => {
        const text = Buffer.concat(chunks).toString('latin1')
        if (text.includes('\r\n\r\n')) {
          assert.match(text, /^HTTP\/1\.1 101 /)
          assert.match(text, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/)
          chunks.length = 0
          socket.off('data', check)
          resolve({ socket, chunks })
        }
      }
      socket.on('data', check)
    })
  try {
    const u = await raw()
    await until(() => host.connections() === 1, 'the raw socket admitted')
    u.socket.write(writeFrame(OP.text, Buffer.from('{"t":"leave"}')), undefined)
    await until(() => u.chunks.length > 0, 'the close frame')
    const frame = Buffer.concat(u.chunks)
    assert.equal(frame[0], 0x88, 'a close frame')
    assert.equal(frame.readUInt16BE(2), 1002)
    await until(() => host.connections() === 0, 'the unmasked peer gone')
    u.socket.destroy()

    const big = await raw()
    await until(() => host.connections() === 1, 'the second raw socket admitted')
    const head = Buffer.from([0x81, 0x80 | 126, (LIMITS.message + 1) >> 8, (LIMITS.message + 1) & 0xff])
    big.socket.write(head)
    await until(() => big.chunks.length > 0, 'the close frame')
    assert.equal(Buffer.concat(big.chunks).readUInt16BE(2), 1009)
    await until(() => host.connections() === 0, 'the big peer gone')
    big.socket.destroy()

    const idle = await open(host)
    await until(() => host.connections() === 1, 'the idle socket admitted')
    clock.now += LIMITS.joinTimeoutMs
    const closed = await idle.closed
    assert.equal(closed.code, 4001)
    assert.equal(closed.reason, 'join timeout')
    await until(() => host.room.peers.size === 0, 'the idle peer gone from the room')
  } finally {
    await host.close()
  }
})

test('a plain HTTP request is told to upgrade; a bad upgrade is refused; the host closes cleanly with a client still joined', async () => {
  const host = await startHost({ secret: SECRET, tickHz: 50 })
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: host.host, port: host.port, path: '/', method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
    req.on('error', reject)
    req.end()
  })
  assert.equal(status, 426)
  const badUpgrade = await new Promise<string>((resolve, reject) => {
    const socket = connect(host.port, host.host)
    const chunks: Buffer[] = []
    socket.on('data', (c: Buffer) => chunks.push(c))
    socket.on('error', reject)
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')))
    socket.on('connect', () => socket.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 12\r\n\r\n`))
  })
  assert.match(badUpgrade, /^HTTP\/1\.1 400 /)
  assert.equal(host.connections(), 0)
  const a = await open(host)
  a.send({ t: 'join', v: PROTOCOL_VERSION, token: a.token, name: 'Ada' })
  await a.next('welcome')
  await host.close()
  const closed = await a.closed
  assert.equal(closed.code, 1001)
  assert.equal(closed.reason, 'host closing')
  assert.equal(host.connections(), 0)
  await assert.rejects(open(host), 'nothing listens after close')
})
