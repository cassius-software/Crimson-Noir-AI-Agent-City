/**
 * Why does this file exist? It proves the Node host (replication.node.ts) over a real loopback socket with Node 22's
 * own WebSocket: tokens are signed with an expiry and refuse tampering; no connection is upgraded without one (the
 * token rides the upgrade as a subprotocol: a missing, forged or expired one is a 401 with no socket, an address that
 * keeps failing is turned away with a 429, and a join must carry the upgrade's own token); frames are read by the RFC
 * 6455 rules (masked from the client, bounded, control frames small) and written unmasked; a good join is welcomed with
 * its spawn; honest inputs move the authoritative pose every snapshot carries to every peer; malformed, replayed,
 * forged and over-rate frames are counted until the peer is removed with a close code; a plain HTTP request is told to
 * upgrade; and the host closes cleanly. With the headless Ring-0 mirror as the authority (the city of the page's seed)
 * it shows crafted illegal movement refused and corrected in the same turn it arrives, the truth unchanged, and a
 * room of walkers judged in microseconds. It also pins the host's own defences: a refused upgrade's socket is ended and
 * a reset after it is no crash, one player holds one connection, a session ends with its token, WebSocket pings are
 * metered, a short secret starts no host, and untrusted text is escaped before it is logged. Every wait is for the host
 * to observe the event, never a fixed sleep.
 * What breaks if it is removed? The door could stop refusing what the core refuses, or a frame rule could drift.
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { request } from 'node:http'
import { connect, type Socket } from 'node:net'
import { canonical, hmacSha256 } from '../02_Define_The_Rules/integrity.ts'
import { RUN } from '../07_Execute_Actions/simProtocol.ts'
import { Mirror } from './mirror.node.ts'
import { planeAuthority, planeStep } from './plane.node.ts'
import {
  AUTH_PREFIX, LIMITS, openServerFrame, PROTOCOL_VERSION, sealMessage, SUBPROTOCOL, unprintable,
  type ClientMessage, type InputMessage, type RemotePlayer, type FootRun, type Run, type ServerMessage,
} from './replication.ts'
import {
  acceptKey, AUTH_FAILURES, closePayload, loggable, MIN_SECRET, mintToken, nodeMac, OP, offeredToken, PINGS_PER_SECOND, readFrame, startHost, verifyToken,
  writeFrame, type Host, type HostOptions,
} from './replication.node.ts'

const SECRET = 'test-secret-of-sixteen+'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Polls until `cond` holds, at most 3 s: the host observes sockets on its own schedule, so the test waits for it rather than guessing. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let t = 0; t < 3000; t += 10) {
    if (cond()) return
    await sleep(10)
  }
  assert.ok(cond(), `still waiting: ${what}`)
}

/** A host over the open plane (plane.node.ts): the protocol's tests, without building the city. */
const plane = (o: Partial<HostOptions> = {}): Promise<Host> => startHost({ secret: SECRET, tickHz: 50, authority: planeAuthority(), ...o })

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
  /** The session token this client's upgrade offered, and the one it joins with and reads the host under. */
  token: string
  got: ServerMessage[]
  /** When each message arrived (performance.now()), index-aligned with `got`. */
  at: number[]
  closed: Promise<{ code: number; reason: string }>
  /** `msg` sealed as the next envelope (a string goes as it is). */
  seal(msg: unknown): string
  send(msg: unknown): void
  /** The next message of kind `t` after `from` entries, within 3 s. */
  next<T extends ServerMessage['t']>(t: T, from?: number): Promise<Extract<ServerMessage, { t: T }>>
}

async function open(host: Host, subject = 'tester', token = host.token(subject)): Promise<Client> {
  const ws = new WebSocket(host.url, [SUBPROTOCOL, AUTH_PREFIX + token])
  const got: ServerMessage[] = []
  const at: number[] = []
  let received = 0
  let sent = 0
  const closed = new Promise<{ code: number; reason: string }>((r) => { ws.onclose = (ev) => r({ code: ev.code, reason: ev.reason }) })
  ws.onmessage = (ev) => {
    const read = openServerFrame(String(ev.data), token, received)
    assert.ok(read.ok, `the host sent something the core refuses: ${String(ev.data)}`)
    received = read.n
    got.push(read.msg)
    at.push(performance.now())
  }
  await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error('socket error')) })
  assert.equal(ws.protocol, SUBPROTOCOL, 'the host answers with the protocol it speaks')
  const seal = (msg: unknown): string => {
    if (typeof msg === 'string') return msg
    const m = msg as { t?: unknown; token?: unknown }
    return sealWithNode(msg, ++sent, m.t === 'join' && typeof m.token === 'string' ? m.token : token)
  }
  const c: Client = {
    ws, token, got, at, closed, seal,
    send: (msg) => ws.send(seal(msg)),
    next: async (t, from = 0) => {
      let found: ServerMessage | undefined
      await until(() => { found = got.slice(from).find((m) => m.t === t); return found !== undefined }, `a '${t}' message`)
      return found as never
    },
  }
  return c
}

/** Joins `c` as `name` to the host's world and returns the welcome. */
async function join(host: Host, c: Client, name: string): Promise<Extract<ServerMessage, { t: 'welcome' }>> {
  c.send({ t: 'join', v: PROTOCOL_VERSION, token: c.token, name, world: host.world })
  return c.next('welcome')
}

/** An input on foot under correction `fix`. */
const input = (seq: number, fix: number, segs: Run[], claim: { x: number; y: number; z: number }, o: Partial<InputMessage> = {}): InputMessage =>
  ({ t: 'input', seq, ack: 0, fix, mode: 'foot', segs, heading: 0, claim, ...o })

/** A client frame, masked as RFC 6455 requires (payloads up to 125 bytes: control frames and short text). */
function maskedFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const mask = Buffer.from([7, 1, 8, 2])
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]))])
}

/** An upgrade over a raw socket: the status line and headers the host answers with, and the socket. */
function rawUpgrade(host: Host, protocol: string | null): Promise<{ socket: Socket; chunks: Buffer[]; head: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(host.port, host.host)
    const chunks: Buffer[] = []
    socket.on('data', (c: Buffer) => chunks.push(c))
    socket.on('error', reject)
    const done = (): void => {
      const text = Buffer.concat(chunks).toString('latin1')
      const end = text.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', done)
      socket.off('close', done)
      const rest = Buffer.concat(chunks).subarray(end + 4)
      chunks.length = 0
      if (rest.length) chunks.push(rest)
      resolve({ socket, chunks, head: text.slice(0, end) })
    }
    socket.on('data', done)
    socket.on('close', done)
    socket.on('connect', () => {
      const proto = protocol === null ? '' : `Sec-WebSocket-Protocol: ${protocol}\r\n`
      socket.write(`GET / HTTP/1.1\r\nHost: ${host.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${proto}\r\n`)
    })
  })
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
  // The signature's other spellings: its last character's low bits are ignored by the decoder, never by the host.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const spellings = [...alphabet].map((c) => `${subject}.${expires}.${mac.slice(0, -1)}${c}`)
  const same = spellings.filter((x) => Buffer.from(x.split('.')[2], 'base64url').equals(Buffer.from(mac, 'base64url')))
  assert.equal(same.length, 4, 'four spellings decode to the one signature')
  assert.deepEqual(same.filter((x) => verifyToken(SECRET, x, 0) !== null), [t], 'only the minted spelling verifies')
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

test('the upgrade\'s token: onyx.4 and exactly one auth entry; the host\'s seals are integrity.ts\'s digest', () => {
  assert.equal(SUBPROTOCOL, 'onyx.4')
  assert.equal(offeredToken(`${SUBPROTOCOL}, ${AUTH_PREFIX}abc.1.xyz`), 'abc.1.xyz')
  assert.equal(offeredToken(`${AUTH_PREFIX}abc, ${SUBPROTOCOL}`), 'abc')
  for (const bad of [undefined, '', SUBPROTOCOL, `${AUTH_PREFIX}abc`, `onyx.2, ${AUTH_PREFIX}abc`, `${SUBPROTOCOL}, ${AUTH_PREFIX}a, ${AUTH_PREFIX}b`, `${SUBPROTOCOL}, ${AUTH_PREFIX}`, 'x'.repeat(2 * LIMITS.token + 1)]) {
    assert.equal(offeredToken(bad), null, String(bad))
  }
  for (const [k, m] of [['key', 'message'], ['x'.repeat(100), '{"n":1}'], ['', '']]) assert.equal(nodeMac(k, m), hmacSha256(k, m))
})

// ---------------------------------------------------------------- over a socket

test('no upgrade without a good token: missing, forged, expired or another secret\'s is a 401 with no socket; an address that keeps failing gets 429s, but a good token still gets in', async () => {
  const host = await plane()
  try {
    const head = async (protocol: string | null): Promise<string> => {
      const r = await rawUpgrade(host, protocol)
      r.socket.destroy()
      return r.head
    }
    const good = host.token('Ada')
    assert.match(await head(null), /^HTTP\/1\.1 401 /, 'no subprotocol at all')
    assert.match(await head(SUBPROTOCOL), /^HTTP\/1\.1 401 /, 'no token offered')
    assert.match(await head(`${SUBPROTOCOL}, ${AUTH_PREFIX}${mintToken('another secret', 'Ada', Date.now() + 60_000)}`), /^HTTP\/1\.1 401 /)
    assert.match(await head(`${SUBPROTOCOL}, ${AUTH_PREFIX}${mintToken(SECRET, 'Ada', Date.now() - 1)}`), /^HTTP\/1\.1 401 /, 'expired')
    assert.match(await head(`${SUBPROTOCOL}, ${AUTH_PREFIX}${good.slice(0, -2)}`), /^HTTP\/1\.1 401 /, 'tampered')
    assert.equal(host.connections(), 0, 'no socket was ever upgraded')
    assert.equal(host.room.peers.size, 0, 'no room slot was ever taken')
    // A refused socket is ended by the host, not left open for the client to hold (a client that keeps it holds a
    // descriptor at most a second), and a reset right after the refusal is no error of the host's.
    const held = await rawUpgrade(host, SUBPROTOCOL)
    await new Promise<void>((r) => { if (held.socket.destroyed) r(); else held.socket.once('close', () => r()) })
    const reset = await rawUpgrade(host, SUBPROTOCOL)
    reset.socket.resetAndDestroy()
    await sleep(50)
    assert.equal(host.stats().unauthorized + host.stats().throttled, AUTH_FAILURES.burst + 2)
    // The address has spent its failures: the next bad token is a 429 (unlogged)…
    const throttled = host.stats().throttled
    assert.match(await head(`${SUBPROTOCOL}, ${AUTH_PREFIX}forged`), /^HTTP\/1\.1 429 /)
    assert.equal(host.stats().throttled, throttled + 1)
    // …but a good token is never locked out (behind a proxy every client shares one address). That probe drops its
    // connection without a close frame: the host lets the peer go at once, not at the idle timeout.
    assert.match(await head(`${SUBPROTOCOL}, ${AUTH_PREFIX}${good}`), /^HTTP\/1\.1 101 /)
    await until(() => host.connections() === 0 && host.room.peers.size === 0, 'the dropped socket let go')
    // A WebSocket sees a refused upgrade as a failure (an error event; a browser closes it with 1006), never an open socket.
    const ws = new WebSocket(host.url, [SUBPROTOCOL, `${AUTH_PREFIX}forged`])
    const outcome = await new Promise<string>((r) => { ws.onerror = () => r('error'); ws.onclose = () => r('close'); ws.onopen = () => r('open') })
    assert.notEqual(outcome, 'open')
  } finally {
    await host.close()
  }
  // A fresh host: the good token upgrades, answering with the protocol; the join must carry that same token.
  const fresh = await plane()
  try {
    const r = await rawUpgrade(fresh, `${SUBPROTOCOL}, ${AUTH_PREFIX}${fresh.token('Ada')}`)
    assert.match(r.head, /^HTTP\/1\.1 101 /)
    assert.match(r.head, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/)
    assert.match(r.head, new RegExp(`Sec-WebSocket-Protocol: ${SUBPROTOCOL.replace('.', '\\.')}`))
    r.socket.destroy()
    const c = await open(fresh, 'Ada')
    c.send({ t: 'join', v: PROTOCOL_VERSION, token: fresh.token('Bob'), name: 'Ada', world: fresh.world })
    await until(() => fresh.room.peers.get(2)?.refusals === 1, 'a join under another token than the upgrade\'s refused')
    assert.equal(c.got.length, 0)
    await join(fresh, c, 'Ada')
  } finally {
    await fresh.close()
  }
})

test('a good join is welcomed with its spawn; honest inputs move the truth every snapshot carries; a second peer sees it; chat and pings are relayed; leaving is announced', async () => {
  const host = await plane()
  try {
    const a = await open(host, 'Ada')
    await until(() => host.connections() === 1, 'the host to see the socket')
    const welcome = await join(host, a, 'Ada')
    assert.deepEqual([welcome.id, welcome.tickHz, welcome.fix, welcome.players], [1, 50, 1, []])
    assert.equal(welcome.you.name, 'Ada')
    const s0 = await a.next('snapshot')
    assert.deepEqual([s0.players, s0.you.x], [[], welcome.you.x])
    const runs: FootRun[] = [[2, 0, 6]]
    const claim = planeStep(welcome.you, runs)
    a.send(input(1, 1, runs, claim, { ack: s0.tick, heading: 1 }))
    await until(() => host.room.peers.get(1)?.seq === 1, 'the input kept')
    const s1 = await a.next('snapshot', a.got.length)
    assert.deepEqual([s1.ack, s1.you.x, s1.you.heading], [1, claim.x, 1])
    assert.ok(Math.abs(s1.you.speed - 2) < 1e-9, `speed ${s1.you.speed}`)

    assert.equal((await a.next('joined')).player.name, 'Ada', 'a peer hears its own arrival, in room order')
    const mark = a.got.length
    const b = await open(host, 'Bob')
    const wb = await join(host, b, 'Bob')
    assert.equal(wb.id, 2)
    assert.deepEqual(wb.players.map((p: RemotePlayer) => [p.name, p.x]), [['Ada', Math.round(claim.x * 1000) / 1000]])
    const joined = await a.next('joined', mark)
    assert.equal(joined.player.name, 'Bob')
    const sb = await b.next('snapshot')
    assert.deepEqual(sb.players.map((p) => p.name), ['Ada'])
    assert.equal(sb.you.name, 'Bob')

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

test('malformed, binary, replayed, forged and over-rate frames count up to a kick with close code 4008; a forged or malformed input is corrected too', async () => {
  const host = await plane()
  try {
    const bad = await open(host)
    bad.send({ t: 'join', v: PROTOCOL_VERSION, token: mintToken(SECRET, 'x', Date.now() - 1), name: 'Ada', world: host.world })
    await until(() => host.room.peers.get(1)?.refusals === 1, 'an expired join token refused')
    bad.send({ t: 'join', v: PROTOCOL_VERSION, token: bad.token, name: 'Ada', world: 'city/7' })
    await until(() => host.room.peers.get(1)?.refusals === 2, 'another world refused')
    assert.equal(bad.got.length, 0, 'no welcome, no word')
    const w = await join(host, bad, 'Ada')
    const peer = () => host.room.peers.get(1)!
    bad.send('{not json')
    bad.send({ ...input(1, 1, [[0, 0, 1]], planeStep(w.you, [[0, 0, 1]])), segs: [[NaN, 0, 1]] })
    bad.ws.send(new Uint8Array([1, 2, 3]))
    await until(() => peer().refusals === 5, 'every crafted frame refused')
    const fixed = await bad.next('correct')
    assert.deepEqual([fixed.fix, fixed.reason], [2, 'input: velocity'], 'the malformed input was answered with a correction')
    // A genuine input is kept once; the very same frame again is a replay, and one sealed under another token a forgery: refused and corrected, keeping nothing.
    const genuine = bad.seal(input(1, 2, [[1, 0, 6]], planeStep(fixed.you, [[1, 0, 6]])))
    bad.send(genuine)
    await until(() => peer().seq === 1, 'the genuine input kept')
    const x = peer().x
    bad.send(genuine)
    bad.send(sealMessage(input(2, 3, [[5, 0, 6]], planeStep({ x: x + 10, z: 0 }, [[5, 0, 6]])), 99, 'another token'))
    await until(() => peer().refusals === 7, 'the replay and the forgery refused')
    assert.deepEqual([peer().seq, peer().x, peer().fix], [1, x, 4], 'nothing kept twice; the forged move never landed; each was corrected')
    assert.equal(7, LIMITS.refusalsBeforeKick - 1)
    assert.equal(peer().joined, true, 'still in the room, one short of the limit')
    bad.send({ t: 'chat', seq: 1, text: 'you idiot' })
    const closed = await bad.closed
    assert.deepEqual([closed.code, closed.reason], [4008, 'repeated refusals'])
    await until(() => host.room.peers.size === 0, 'the peer gone from the room')

    // A flood of inputs past the burst is refused by the rate limit until the peer is removed. Five times the burst, so
    // that however slowly a loaded machine delivers them, the bucket's refill cannot keep up.
    const flood = await open(host)
    const wf = await join(host, flood, 'Flood')
    const still = planeStep(wf.you, [[0, 0, 0]])
    for (let seq = 1; seq <= 5 * LIMITS.inputBurst && flood.ws.readyState === WebSocket.OPEN; seq++) flood.send(input(seq, 1, [[0, 0, 0]], still))
    assert.equal((await flood.closed).code, 4008)
  } finally {
    await host.close()
  }
})

test('an unmasked frame or an over-size frame closes the socket with the RFC code; a peer that never joins is dropped by the join timeout rule', async () => {
  const clock = { now: Date.now() }
  const host = await plane({ tickHz: 100, now: () => clock.now })
  const raw = async (): Promise<{ socket: Socket; chunks: Buffer[] }> => {
    const r = await rawUpgrade(host, `${SUBPROTOCOL}, ${AUTH_PREFIX}${host.token('raw')}`)
    assert.match(r.head, /^HTTP\/1\.1 101 /)
    return r
  }
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
  const host = await plane()
  try {
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
  await join(host, a, 'Ada')
  await host.close()
  const closed = await a.closed
  assert.equal(closed.code, 1001)
  assert.equal(closed.reason, 'host closing')
  assert.equal(host.connections(), 0)
  await assert.rejects(open(host), 'nothing listens after close')
  } finally {
    await host.close()
  }
})

test('a peer too slow to read what it is sent is closed (4009) before the host buffers it: every write checks the backlog first', async () => {
  // A loopback socket's kernel buffers take megabytes before Node holds a byte, so the rule is read from the code: the
  // one write path checks the unread backlog against maxBacklog before it writes, and closes the peer instead; text
  // frames and pongs both go through it, and the close frame is written only under the same bound.
  const { readFileSync } = await import('node:fs')
  const code = readFileSync(new URL('./replication.node.ts', import.meta.url), 'utf8')
  const write = code.slice(code.indexOf('const write = (c: Conn, frame: Buffer): void => {'), code.indexOf('const send ='))
  assert.match(write, /if \(c\.socket\.writableLength > maxBacklog\) \{\s*if \(!c\.closing\) close\(c, 4009, 'too slow to keep up'\)\s*c\.socket\.destroy\(\)\s*return\s*\}\s*c\.socket\.write\(frame\)/)
  assert.equal(code.match(/c\.socket\.write\(/g)?.length, 2, 'the write path, and the close frame under the same bound')
  assert.match(code, /c\.socket\.writableLength <= maxBacklog\) c\.socket\.write\(writeFrame\(OP\.close/)
  assert.match(code, /write\(c, writeFrame\(OP\.text/)
  assert.match(code, /write\(c, writeFrame\(OP\.pong/)
})

test('the backlog rule in action: with a bound every write is past, the first message for a peer closes it instead (logged as too slow) and takes it out of the room', async () => {
  const lines: string[] = []
  const host = await plane({ maxBacklog: -1, log: (l) => lines.push(l) })
  try {
    const c = await open(host, 'Ada')
    // The join's welcome is the first message the host would write to this peer.
    c.send({ t: 'join', v: PROTOCOL_VERSION, token: c.token, name: 'Ada', world: host.world })
    await until(() => lines.some((l) => /closed: too slow to keep up/.test(l)), 'closed as too slow to keep up')
    assert.equal(c.got.length, 0, 'nothing was written past the bound: not the welcome, not even the close frame')
    await c.closed
    await until(() => host.room.peers.size === 0 && host.connections() === 0, 'out of the room, the socket gone')
  } finally {
    await host.close()
  }
})

test('one player, one connection: a second under the same subject replaces the first (4010); a session ends with its token (4003)', async () => {
  const clock = { now: Date.now() }
  const host = await plane({ tickHz: 100, now: () => clock.now })
  try {
    const first = await open(host, 'Ada')
    await join(host, first, 'Ada')
    // Another token minted for the same player: the first connection gives way.
    const second = await open(host, 'Ada', host.token('Ada', 10_000))
    const closed = await first.closed
    assert.deepEqual([closed.code, closed.reason], [4010, 'replaced by a new connection'])
    await join(host, second, 'Ada')
    await until(() => host.connections() === 1 && host.room.peers.size === 1, 'one slot for Ada')
    // A token good for ten seconds (less than the idle timeout): the session ends when it does, whatever the peer does.
    clock.now += 10_001
    const ended = await second.closed
    assert.deepEqual([ended.code, ended.reason], [4003, 'token expired'])
    await until(() => host.connections() === 0, 'the expired session gone')
  } finally {
    await host.close()
  }
})

test('the removals over a socket: ten corrections a minute and the eleventh closes 4008; a joined peer silent past the idle timeout is let go (4001)', async () => {
  const clock = { now: Date.now() }
  const host = await plane({ tickHz: 100, now: () => clock.now })
  try {
    const liar = await open(host, 'liar')
    const w = await join(host, liar, 'Liar')
    let fix = w.fix
    for (let seq = 1; seq <= LIMITS.correctionsPerMinute + 1 && liar.ws.readyState === WebSocket.OPEN; seq++) {
      const from = liar.got.length
      liar.send(input(seq, fix, [[0, 0, 1]], { x: 999, y: 0, z: 0 }))
      if (seq <= LIMITS.correctionsPerMinute) fix = (await liar.next('correct', from)).fix
    }
    const closed = await liar.closed
    assert.deepEqual([closed.code, closed.reason], [4008, 'repeated illegal movement'])
    const quiet = await open(host, 'quiet')
    await join(host, quiet, 'Quiet')
    clock.now += LIMITS.idleTimeoutMs
    const idle = await quiet.closed
    assert.deepEqual([idle.code, idle.reason], [4001, 'idle'])
    await until(() => host.room.peers.size === 0, 'both gone from the room')
  } finally {
    await host.close()
  }
})

test('WebSocket pings are metered: a flood of them is refused and the peer removed (4008), joined or not', async () => {
  const host = await plane()
  try {
    const r = await rawUpgrade(host, `${SUBPROTOCOL}, ${AUTH_PREFIX}${host.token('pinger')}`)
    assert.match(r.head, /^HTTP\/1\.1 101 /)
    const closedAt = new Promise<void>((done) => r.socket.once('close', () => done()))
    // The burst is answered with pongs; past it every ping is a refusal, and the eighth removes the peer.
    const n = 2 * PINGS_PER_SECOND + 20
    r.socket.write(Buffer.concat(Array.from({ length: n }, () => maskedFrame(OP.ping, Buffer.from('x')))))
    await until(() => Buffer.concat(r.chunks).includes(Buffer.from([0x88])), 'a close frame')
    const frames = Buffer.concat(r.chunks)
    const at = frames.indexOf(Buffer.from([0x88]))
    let pongs = 0
    for (let i = 0; i < at; i++) if (frames[i] === 0x8a) pongs++
    assert.ok(pongs <= 2 * PINGS_PER_SECOND + 1, `${pongs} pongs`)
    assert.equal(frames.readUInt16BE(at + 2), 4008)
    r.socket.end()
    await closedAt
  } finally {
    await host.close()
  }
})

test('a short secret starts no host; untrusted text is one escaped, bounded line in the log', async () => {
  for (const secret of ['', 'x'.repeat(MIN_SECRET - 1)]) await assert.rejects(startHost({ secret, authority: planeAuthority() }), /at least 16 characters/)
  assert.equal(loggable('a\nb'), 'a\\nb')
  assert.equal(loggable('peer 1 closed: x\r\npeer 7 banned'), 'peer 1 closed: x\\r\\npeer 7 banned')
  assert.equal(loggable('"quoted"'), '\\"quoted\\"')
  // C1 controls (a CSI that erases the line, a "next line"), DEL, the line and paragraph separators and bidi overrides
  // are escaped too: JSON alone leaves them raw.
  assert.equal(loggable('a\u0085b\u2028c\u009b2K\u007fd\u2029e\u202ef'), 'a\\u0085b\\u2028c\\u009b2K\\u007fd\\u2029e\\u202ef')
  assert.equal(loggable('y'.repeat(500)).length, 160, 'at most 160 characters, the ellipsis included')
  assert.equal(loggable('y'.repeat(160)), 'y'.repeat(160))
  const astral = loggable('😀'.repeat(200))
  assert.ok(astral.length <= 160 && !/[\ud800-\udbff]…$/.test(astral), 'never half a surrogate pair')
  const plain = (l: string): boolean => [...l].every((ch) => !unprintable(ch.codePointAt(0) ?? 0))
  // The log lines a client can steer go through it: a refusal names the value it refused, raw as it was sent.
  const lines: string[] = []
  const host = await plane({ log: (l) => lines.push(l) })
  try {
    const c = await open(host, 'Ada')
    c.send({ t: 'join', v: '\u009b2K\u0085peer 999 connected\u2028x', token: '', name: 'Ada', world: 'plane' })
    await until(() => lines.some((l) => l.includes('refused')), 'the refusal logged')
    const refused = lines.find((l) => l.includes('refused'))!
    assert.match(refused, /\\u009b2K\\u0085peer 999 connected\\u2028x/, 'the value is in the line, escaped')
    assert.ok(lines.every(plain), lines.join(' | '))
    assert.ok(lines.every((l) => l.length <= 200), 'bounded')
  } finally {
    await host.close()
  }
})

// ---------------------------------------------------------------- the mirror as the authority

test('the mirror on the socket: crafted illegal movement is refused and corrected in the same turn it arrives, the truth unchanged; honest walking is kept', async () => {
  // Snapshots once a second, so the answer to a crafted packet is plainly the correction, not a tick.
  const host = await startHost({ secret: SECRET, tickHz: 1 })
  const predictor = await Mirror.create(1337)
  try {
    assert.equal(host.world, 'city/1337/36')
    const c = await open(host, 'Ada')
    const w = await join(host, c, 'Ada')
    // The client's own prediction: the same controller on the same city (the page's realm agrees within a micrometre,
    // mirror.node.test.ts), put down at the welcome's spawn as the page is.
    predictor.join(w.id)
    predictor.place(w.id, w.you.x, w.you.z)
    let seq = 0
    let fix = w.fix
    const walk = (runs: FootRun[]): InputMessage => {
      const p = predictor.walk(w.id, runs)
      return input(++seq, fix, runs, { x: p.x, y: p.y, z: p.z })
    }
    const truth = () => host.room.peers.get(w.id)!
    // Honest: two seconds south along the spawn sidewalk, half a second at a time, paced like a client.
    for (let k = 0; k < 4; k++) {
      c.send(walk([[0, RUN, 30]]))
      await sleep(500)
    }
    await until(() => truth().seq === seq, 'the honest walk kept')
    assert.ok(truth().z > w.you.z + 9, `walked: z ${w.you.z} → ${truth().z}`)
    const kept = { x: truth().x, z: truth().z }

    // Each crafted packet: sent, then the very next message is its correction; the truth has not moved.
    const crafted = async (msg: unknown, why: RegExp): Promise<number> => {
      const from = c.got.length
      const t0 = performance.now()
      c.send(msg)
      const corr = await c.next('correct', from)
      const i = c.got.indexOf(corr)
      assert.equal(i, from, `the next message is the correction (${c.got.slice(from, i).map((m) => m.t).join(', ')})`)
      assert.match(corr.reason, why)
      assert.deepEqual([corr.you.x, corr.you.z], [kept.x, kept.z], 'the truth is where it was')
      assert.equal(corr.fix, fix + 1)
      fix = corr.fix
      // The client snaps: put down standing at the truth.
      predictor.place(w.id, corr.you.x, corr.you.z)
      return c.at[i] - t0
    }
    const ms: number[] = []
    // 1. Memory written: an honest run, the claim 40 m along.
    const honestNext = walk([[0, RUN, 6]])
    ms.push(await crafted({ ...honestNext, claim: { ...honestNext.claim, z: honestNext.claim.z + 40 } }, /claim .* from the mirror's pose/))
    // 2. A speed hack in the shape: 600 substeps in one packet.
    ms.push(await crafted(input(++seq, fix, [[0, RUN, 600]], { x: kept.x, y: 0.92, z: kept.z + 52 }), /input: substeps/))
    // 3. A speed hack on the clock: the room banks LIMITS.stepBurst substeps. Once the bank is full again, six honest
    //    bursts of half a second spend it, each kept; the seventh, at once, is a clock running fast, and its correction
    //    acknowledges the sixth (so it is the hack that was refused, not an honest burst before it).
    await sleep(3200)
    const burst = (): InputMessage => walk([[0, 0, 30]])
    for (let k = 0; k < LIMITS.stepBurst / 30; k++) c.send(burst())
    const lastHonest = seq
    ms.push(await crafted(burst(), /more substeps than time allows/))
    const clockHack = c.got.filter((m) => m.t === 'correct').at(-1)!
    assert.equal(clockHack.ack, lastHonest, `the correction acknowledges the sixth burst (seq ${lastHonest}), so the seventh was the one refused`)
    await sleep(600)
    // 4. Through a wall: the lot east of the sidewalk (a podium from x 327 m), the claim on the straight line.
    ms.push(await crafted(input(++seq, fix, [[RUN, 0, 30]], { x: kept.x + RUN * 0.5, y: 0.92, z: kept.z }), /claim .* from the mirror's pose/))
    assert.ok(truth().x < 327 - 0.25, `the truth never entered the lot: x ${truth().x}`)
    // 5. A teleport through a door: car 0's own state, claimed where the player is not.
    const car = host.room.authority as unknown as Mirror
    const seat = car.garage.plan[0].pose
    const yaw = seat.heading - Math.PI / 2
    const state = { x: seat.x, y: 0.56, z: seat.z, qx: 0, qy: Math.sin(yaw / 2), qz: 0, qw: Math.cos(yaw / 2), vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
    ms.push(await crafted(input(++seq, fix, [[0, 0, 0, 0, 1]], state, { mode: 'drive', door: { enter: { car: 0, state } } }), /from the room's pose/))
    for (const t of ms) assert.ok(t < 250, `answered in ${t.toFixed(1)} ms`)
    const st = host.stats()
    assert.ok(st.corrected >= 5 && st.kept >= 4, JSON.stringify(st))
    assert.ok(st.inputUs > 0, 'inputs timed (the walkers\' test bounds the cost)')
  } finally {
    await host.close()
  }
})

test('a room of walkers on the mirror: every honest input kept, each judged in well under a millisecond', async () => {
  const host = await startHost({ secret: SECRET, tickHz: 20 })
  const predictor = await Mirror.create(1337)
  try {
    const N = 12, STEPS = 30
    const clients = await Promise.all(Array.from({ length: N }, (_, k) => open(host, `walker${k}`)))
    const welcomes = []
    for (let k = 0; k < N; k++) welcomes.push(await join(host, clients[k], `Walker ${k}`))
    for (const w of welcomes) {
      predictor.join(w.id)
      predictor.place(w.id, w.you.x, w.you.z)
    }
    for (let i = 1; i <= STEPS; i++) {
      for (let k = 0; k < N; k++) {
        const id = welcomes[k].id
        const runs: FootRun[] = [[Math.sin(k) * RUN, Math.cos(k) * RUN, 1]]
        const p = predictor.walk(id, runs)
        clients[k].send(input(i, 1, runs, { x: p.x, y: p.y, z: p.z }))
      }
      await sleep(1000 / 60)
    }
    await until(() => [...host.room.peers.values()].every((p) => p.seq === STEPS), 'every input kept')
    const st = host.stats()
    assert.deepEqual([st.inputs, st.kept, st.corrected, st.stale], [N * STEPS, N * STEPS, 0, 0])
    assert.ok(st.inputUs < 1000, `${st.inputUs.toFixed(0)} µs an input`)
    await until(() => host.stats().tickUs > 0, 'a tick measured')
  } finally {
    await host.close()
  }
})
