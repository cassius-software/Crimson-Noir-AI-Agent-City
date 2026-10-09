// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the host's churn and memory proof (the Phase 16 audit): the Node host
 * (replication.node.ts) in this process over real loopback sockets, put through what a day on the open internet brings
 * — thousands of upgrades with bad tokens from one address and from ten thousand spoofed loopback addresses, hundreds
 * of players that join and leave, that drop their link without a close frame, that reconnect under the same token, that
 * go silent, and hundreds of ledger sessions (ledger.node.ts) — and after every phase the host must be back where it
 * started: no socket, no timer, no room slot and no ledger session left behind; the per-address failure buckets swept
 * once their budget is whole (measured: ten thousand of them freed from the heap); one set of verified weights kept
 * however many ledgers verified (measured: the ArrayBuffers stay under a megabyte, where three hundred kept ledgers
 * would be forty); and the heap, after a forced collection, flat from one round of churn to the next. The room is also
 * run for thousands of ticks on the headless Ring-0 mirror (mirror.node.ts: Rapier in WebAssembly) with eight walkers,
 * every input kept, and its heap, its external (wasm) memory and its snapshot sizes must not grow; and two rooms fed one
 * seeded random script of inputs, chat and pings must write byte-identical sealed frames, on the open plane and on two
 * mirrors (the room is deterministic). Every wait is for the host to observe the event, never a fixed sleep, and every
 * random case replays from its seed (02_Define_The_Rules/property.ts).
 * What breaks if it is removed? A slow leak under churn, a timer or socket a dropped peer leaves behind, or a
 * nondeterminism in the room would reach a long-running host unnoticed.
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { canonical, sha256 } from '../02_Define_The_Rules/integrity.ts'
import { forAll, gen, type Gen } from '../02_Define_The_Rules/property.ts'
import { RUN } from '../07_Execute_Actions/simProtocol.ts'
import { LEARN, LEDGER_GENESIS, LEDGER_SUBPROTOCOL, link, type EntryBody } from './ledger.ts'
import { Mirror } from './mirror.node.ts'
import { planeAuthority, planeStep } from './plane.node.ts'
import {
  admit, AUTH_PREFIX, createRoom, depart, handle, LIMITS, openServerFrame, poses, PROTOCOL_VERSION, sealMessage, snapshotFor, SUBPROTOCOL, tickRoom,
  type Authority, type ClientMessage, type FootRun, type Peer, type Room, type ServerMessage,
} from './replication.ts'
import { AUTH_FAILURES, nodeMac, startHost, type Host } from './replication.node.ts'

const SECRET = 'churn-test-secret-sixteen+'
const OS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'crimson_noir_os')
const CANONICAL = readFileSync(join(OS, 'containment.canonical'), 'utf8')
const PINNED = sha256(CANONICAL)
const MB = 1024 * 1024

// A collector on demand, whether or not this process was started with --expose-gc: the flag is set on the running VM
// and `gc` read from a fresh context, where it is then defined.
setFlagsFromString('--expose_gc')
const gc = runInNewContext('gc') as () => void

interface Mem { heapUsed: number; external: number; arrayBuffers: number }
/** The process's memory after two full collections (the second takes what the first's finalizers freed). */
function settled(): Mem {
  gc()
  gc()
  const m = process.memoryUsage()
  return { heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers }
}
const mb = (bytes: number): string => `${(bytes / MB).toFixed(2)} MB`

// Timer accounting: the host makes its deadlines through the global setTimeout (a refused socket's linger, a closing
// socket's destroy, the server's own close), unref'd, which process.getActiveResourcesInfo never lists. Every timer made
// through the global while a host runs is tracked here until it fires or is cleared; this file's own waits go through
// the real one and are never counted.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const liveTimers = new Set<NodeJS.Timeout>()
function countTimers(): () => void {
  const counting = (fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]): NodeJS.Timeout => {
    const t = realSetTimeout(() => { liveTimers.delete(t); fn(...a) }, ms)
    liveTimers.add(t)
    return t
  }
  const clearing = (t: NodeJS.Timeout | string | number | undefined): void => {
    if (typeof t === 'object') liveTimers.delete(t)
    realClearTimeout(t)
  }
  const G = globalThis as unknown as { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }
  G.setTimeout = counting as unknown as typeof setTimeout
  G.clearTimeout = clearing as typeof clearTimeout
  return () => {
    G.setTimeout = realSetTimeout
    G.clearTimeout = realClearTimeout
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => realSetTimeout(r, ms))

async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  for (let t = 0; t < ms; t += 5) {
    if (cond()) return
    await sleep(5)
  }
  assert.ok(cond(), `still waiting: ${what}`)
}

/** Live libuv handles by type (sockets on both sides of the loopback live in this process). */
function resources(): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of process.getActiveResourcesInfo()) out.set(r, (out.get(r) ?? 0) + 1)
  return out
}
const sockets = (): number => resources().get('TCPSocketWrap') ?? 0

const upgradeText = (protocol: string): string =>
  `GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`

/** A raw upgrade, from `localAddress` when given: the status line the host answered with, and the socket. */
function rawUpgrade(host: Host, protocol: string, localAddress?: string): Promise<{ socket: Socket; status: string; gone: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port: host.port, host: host.host, localAddress })
    const chunks: Buffer[] = []
    const gone = new Promise<void>((r) => socket.once('close', () => r()))
    let done = false
    const finish = (): void => {
      if (done) return
      const text = Buffer.concat(chunks).toString('latin1')
      const end = text.indexOf('\r\n')
      if (end < 0 && !socket.destroyed) return
      done = true
      resolve({ socket, status: end < 0 ? text : text.slice(0, end), gone })
    }
    socket.on('error', (e) => { if (!done) reject(e) })
    socket.on('data', (c: Buffer) => { chunks.push(c); finish() })
    socket.on('close', finish)
    socket.on('connect', () => socket.write(upgradeText(protocol)))
  })
}

/** What the host sends: the room's messages, or the ledger door's (sealed the same way, read here by hand). */
interface LedgerReply { t: string; [k: string]: unknown }
type Got = ServerMessage | LedgerReply

interface Client {
  ws: WebSocket
  token: string
  got: Got[]
  closed: Promise<{ code: number; reason: string }>
  /** A room message, sealed as the next envelope (a join under the token it carries). */
  send(msg: ClientMessage): void
  /** A ledger-door message, sealed as the next envelope under the session token. */
  sendLedger(body: Record<string, unknown>): void
  next(t: string, from?: number): Promise<Got>
}

const mac = (key: string, n: number, body: unknown): string => createHmac('sha256', key).update(canonical({ n, body }), 'utf8').digest('hex')

/** A client over Node's own WebSocket on one of the host's two doors, every message the host sends opened and checked. */
async function wsClient(host: Host, subject: string, protocol: string = SUBPROTOCOL, token: string = host.token(subject)): Promise<Client> {
  const ws = new WebSocket(host.url, [protocol, AUTH_PREFIX + token])
  const got: Got[] = []
  let received = 0
  let sent = 0
  const closed = new Promise<{ code: number; reason: string }>((r) => { ws.onclose = (ev) => r({ code: ev.code, reason: ev.reason }) })
  ws.onmessage = (ev) => {
    if (protocol === SUBPROTOCOL) {
      const read = openServerFrame(String(ev.data), token, received)
      assert.ok(read.ok, `the host sent something the core refuses: ${String(ev.data)}`)
      received = read.n
      got.push(read.msg)
    } else {
      const env = JSON.parse(String(ev.data)) as { n: number; body: LedgerReply; mac: string }
      assert.equal(env.mac, mac(token, env.n, env.body), 'the ledger door seals under the session token')
      assert.ok(env.n > received, 'the envelope number rises')
      received = env.n
      got.push(env.body)
    }
  }
  await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error(`socket error (${subject})`)) })
  return {
    ws, token, got, closed,
    send: (msg) => ws.send(sealMessage(msg, ++sent, msg.t === 'join' ? msg.token : token, nodeMac)),
    sendLedger: (body) => { const n = ++sent; ws.send(JSON.stringify({ n, body, mac: mac(token, n, body) })) },
    next: async (t, from = 0) => {
      let found: Got | undefined
      await until(() => { found = got.slice(from).find((m) => m.t === t); return found !== undefined }, `a '${t}' message (${subject})`)
      return found as Got
    },
  }
}

const joinMsg = (host: Host, c: Client, name: string): ClientMessage => ({ t: 'join', v: PROTOCOL_VERSION, token: c.token, name, world: host.world })

/** A short valid ledger: `n` learn entries for couriers (declared with `learn`), chained, with the fold's head and digest. */
function ledgerEntries(n: number, salt: number): { entries: (number | string)[][]; head: string; digest: string } {
  const entries: (number | string)[][] = []
  const weights = new Int32Array(4096 * 8)
  let head = LEDGER_GENESIS
  for (let k = 0; k < n; k++) {
    const body: EntryBody = [LEARN, k, (k * 7 + salt) % 3072, k % 8, Math.floor((1 << 22) / (64 + ((k * 131 + salt) % 1000)))]
    head = link(body, head)
    entries.push([...body, head])
    const i = body[2] * 8 + body[3]
    weights[i] = (weights[i] + (((body[4] - weights[i]) | 0) >> 3)) | 0
  }
  const pairs: [number, number][] = []
  for (let i = 0; i < weights.length; i++) if (weights[i] !== 0) pairs.push([i, weights[i]])
  return { entries, head, digest: sha256(canonical(pairs)) }
}

/** Every batch of `size` out of `total`, so no phase holds more sockets at once than the room has slots for. */
function* batches(total: number, size: number): Generator<number[]> {
  for (let i = 0; i < total; i += size) yield Array.from({ length: Math.min(size, total - i) }, (_, k) => i + k)
}

// ---------------------------------------------------------------- the host under churn

test('the host under churn: bad tokens from one and from ten thousand addresses, players that leave, drop, reconnect and fall silent, ledger sessions; nothing left behind and the heap flat round to round', async (t) => {
  const restore = countTimers()
  const clock = { now: 1_700_000_000_000 }
  let logLines = 0
  const host = await startHost({ secret: SECRET, tickHz: 50, authority: planeAuthority(), ledgerLock: PINNED, now: () => clock.now, log: () => { logLines++ } })
  const SWEEP_MS = (AUTH_FAILURES.burst / AUTH_FAILURES.perSecond) * 1000 + 1000
  // Whether this machine lets a socket bind another loopback address (Linux: all of 127/8; elsewhere often not).
  const spoofable = await rawUpgrade(host, SUBPROTOCOL, '127.0.0.2').then((r) => { r.socket.destroy(); return true }, () => false)
  if (!spoofable) t.diagnostic('spoofed loopback addresses cannot be bound here: the ten-thousand-address phase is skipped')
  const quiet = async (what: string): Promise<void> => {
    await until(() => host.connections() === 0 && host.room.peers.size === 0 && (host.ledger()?.sessions ?? 0) === 0 && liveTimers.size === 0 && sockets() === 0, what)
  }
  try {
    const round = async (label: string): Promise<Mem> => {
      const t0 = performance.now()
      const stats0 = host.stats()
      // 1. Two thousand bad tokens from one address: the burst is answered 401, the rest 429, none upgraded.
      const counts = { 401: 0, 429: 0, other: 0 }
      for (const batch of batches(2000, 50)) {
        const rs = await Promise.all(batch.map((i) => rawUpgrade(host, `${SUBPROTOCOL}, ${AUTH_PREFIX}forged.${i}`)))
        for (const r of rs) { if (r.status.includes(' 401 ')) counts[401]++; else if (r.status.includes(' 429 ')) counts[429]++; else counts.other++; r.socket.destroy() }
        await Promise.all(rs.map((r) => r.gone))
      }
      assert.deepEqual(counts, { 401: AUTH_FAILURES.burst, 429: 2000 - AUTH_FAILURES.burst, other: 0 }, `${label}: one address's failures`)
      assert.equal(host.stats().unauthorized - stats0.unauthorized, AUTH_FAILURES.burst)
      assert.equal(host.stats().throttled - stats0.throttled, 2000 - AUTH_FAILURES.burst)
      // 2. Ten thousand distinct spoofed loopback addresses, one bad token each: a bucket per address, every one a 401.
      if (spoofable) {
        let a401 = 0
        for (const batch of batches(10_000, 100)) {
          const rs = await Promise.all(batch.map((k) => { const n = k + 2; return rawUpgrade(host, `${SUBPROTOCOL}, ${AUTH_PREFIX}forged`, `127.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`) }))
          for (const r of rs) { if (r.status.includes(' 401 ')) a401++; r.socket.destroy() }
          await Promise.all(rs.map((r) => r.gone))
        }
        assert.equal(a401, 10_000, `${label}: each address has its own budget`)
      }
      assert.equal(host.connections(), 0, 'no refused upgrade holds a connection')
      await until(() => liveTimers.size === 0 && sockets() === 0, 'every refused socket closed on both sides and its linger timer cleared')
      const live = settled()
      // The buckets live until their budget is whole again (burst / perSecond), then the tick sweeps them: the heap
      // drops by what ten thousand of them held (measured: about 1.7 MB; a Map entry and a bucket are over 40 bytes).
      clock.now += SWEEP_MS
      let swept = settled()
      if (spoofable) {
        await until(() => { swept = settled(); return live.heapUsed - swept.heapUsed > 10_000 * 40 }, `the failure buckets swept (heap ${mb(live.heapUsed)} with them live)`, 3000)
      } else await sleep(100)
      // Swept means forgotten: the throttled address's next failure is a 401 again, on a fresh budget.
      const again = await rawUpgrade(host, `${SUBPROTOCOL}, ${AUTH_PREFIX}forged`)
      assert.match(again.status, / 401 /, `${label}: a swept address starts afresh`)
      again.socket.destroy()
      await again.gone
      clock.now += SWEEP_MS
      // 3. Five hundred players that join and leave with a close handshake.
      for (const batch of batches(500, 25)) {
        const cs = await Promise.all(batch.map((k) => wsClient(host, `leaver${k}`)))
        for (const [k, c] of cs.entries()) c.send(joinMsg(host, c, `Leaver ${k}`))
        for (const c of cs) await c.next('welcome')
        for (const c of cs) c.send({ t: 'leave' })
        for (const c of cs) assert.equal((await c.closed).code, 1000, 'left')
      }
      await quiet(`${label}: the leavers gone`)
      // 4. Five hundred upgraded sockets dropped without a close frame: half ended and destroyed, half reset.
      for (const batch of batches(500, 25)) {
        const rs = await Promise.all(batch.map((k) => rawUpgrade(host, `${SUBPROTOCOL}, ${AUTH_PREFIX}${host.token(`dropper${k}`)}`)))
        for (const [k, r] of rs.entries()) {
          assert.match(r.status, / 101 /, 'upgraded')
          if (k & 1) r.socket.resetAndDestroy()
          else r.socket.destroy()
        }
        await Promise.all(rs.map((r) => r.gone))
      }
      await quiet(`${label}: the droppers gone`)
      // 5. Three hundred ledger sessions: hello, a few entries, the seal, verified, closed.
      const verified0 = host.ledger()?.verified ?? 0
      for (const batch of batches(300, 25)) {
        const cs = await Promise.all(batch.map((k) => wsClient(host, `ledger${k}`, LEDGER_SUBPROTOCOL)))
        for (const c of cs) c.sendLedger({ t: 'hello', v: 1, config: CANONICAL })
        for (const c of cs) await c.next('ready')
        for (const [k, c] of cs.entries()) {
          const l = ledgerEntries(5, batch[k])
          c.sendLedger({ t: 'entries', list: l.entries })
          c.sendLedger({ t: 'seal', head: l.head, count: 5, weights: l.digest })
        }
        for (const c of cs) await c.next('verified')
        for (const c of cs) c.ws.close(1000)
        for (const c of cs) assert.equal((await c.closed).code, 1000)
      }
      assert.equal(host.ledger()?.verified, verified0 + 300)
      assert.equal(host.ledger()?.refused, 0)
      await quiet(`${label}: the ledger sessions gone`)
      // The door keeps the weights of the last verified ledger per configuration, not of every one: three hundred
      // kept would be forty megabytes of Int32Array (4096 × 8 × 4 bytes each).
      let buffers = settled().arrayBuffers
      await until(() => { buffers = settled().arrayBuffers; return buffers < 1 * MB }, `one set of weights kept, not three hundred (ArrayBuffers ${mb(buffers)})`, 3000)
      // 6. Two hundred sessions replaced by a reconnect under the same subject: the first is closed 4010, the second plays.
      for (const batch of batches(200, 20)) {
        const firsts = await Promise.all(batch.map((k) => wsClient(host, `same${k}`)))
        for (const c of firsts) c.send(joinMsg(host, c, 'Same'))
        for (const c of firsts) await c.next('welcome')
        const seconds = await Promise.all(batch.map((k) => wsClient(host, `same${k}`)))
        for (const c of firsts) assert.equal((await c.closed).code, 4010, 'replaced')
        for (const c of seconds) c.send(joinMsg(host, c, 'Same'))
        for (const c of seconds) await c.next('welcome')
        for (const c of seconds) c.ws.close(1000)
        for (const c of seconds) await c.closed
      }
      await quiet(`${label}: the replaced gone`)
      // 7. A hundred that go silent, in batches the room holds: some never join, some join and say nothing more.
      for (const batch of batches(100, 25)) {
        const unjoined = await Promise.all(batch.slice(0, 12).map((k) => wsClient(host, `quietA${k}`)))
        const joined = await Promise.all(batch.slice(12).map((k) => wsClient(host, `quietB${k}`)))
        for (const c of joined) c.send(joinMsg(host, c, 'Quiet'))
        for (const c of joined) await c.next('welcome')
        await until(() => host.connections() === 25, 'the quiet ones seen')
        clock.now += LIMITS.idleTimeoutMs
        for (const c of unjoined) assert.deepEqual(await c.closed, { code: 4001, reason: 'join timeout' })
        for (const c of joined) assert.deepEqual(await c.closed, { code: 4001, reason: 'idle' })
      }
      await quiet(`${label}: the quiet gone`)
      const end = settled()
      t.diagnostic(`${label}: ${((performance.now() - t0) / 1000).toFixed(1)} s; heap ${mb(end.heapUsed)}, external ${mb(end.external)}, ArrayBuffers ${mb(end.arrayBuffers)}; buckets live ${mb(live.heapUsed)} → swept ${mb(swept.heapUsed)}; ${logLines} log lines`)
      return end
    }
    const first = await round('round 1')
    const second = await round('round 2')
    // Everything the round made is gone: what remains between rounds is the JIT's own code (measured: about 1 MB
    // from the first round to the second, 0.3 MB after). A connection, a peer, a bucket or a session left behind per
    // churned socket would be several megabytes a round.
    const grew = second.heapUsed - first.heapUsed
    assert.ok(grew < 2.5 * MB, `the heap grew ${mb(grew)} over one round of churn`)
    assert.ok(second.arrayBuffers - first.arrayBuffers < 0.5 * MB, `ArrayBuffers grew ${mb(second.arrayBuffers - first.arrayBuffers)}`)
    assert.ok(second.external - first.external < 1 * MB, `external memory grew ${mb(second.external - first.external)}`)
    assert.equal(host.stats().peers, 0)
    assert.equal(host.ledger()?.sessions, 0)
  } finally {
    await host.close()
    // The server's own close deadline fires within 1.1 s; then no handle and no timer of the host's remains.
    await until(() => liveTimers.size === 0 && sockets() === 0 && (resources().get('TCPServerWrap') ?? 0) === 0, 'the host gone', 3000)
    restore()
  }
})

// ---------------------------------------------------------------- the room over time, and its determinism

/** A room driven in this process: every sealed frame the host would write, in order, and the clock. */
interface Driven {
  room: Room
  peers: Peer[]
  sent: Map<number, number>
  out: string[]
}
const KEY = 'a-session-key'

function drive(authority: Authority, n: number, now: number): Driven {
  const room = createRoom(authority, 20)
  const peers: Peer[] = []
  for (let k = 0; k < n; k++) {
    const p = admit(room, now)
    assert.ok(p)
    peers.push(p)
  }
  return { room, peers, sent: new Map(), out: [] }
}

const seal = (R: Driven, k: number, msg: ServerMessage): string => {
  const n = (R.sent.get(k) ?? 0) + 1
  R.sent.set(k, n)
  return sealMessage(msg, n, KEY, nodeMac)
}

/** One message from peer `k`, applied as the host applies it; records the reply, the broadcast and a departure. */
function apply(R: Driven, k: number, msg: ClientMessage, now: number): { kept: boolean; corrected: boolean; gone: boolean } {
  const peer = R.peers[k]
  const seqWas = peer.seq, fixWas = peer.fix
  const o = handle(R.room, peer, msg, now, () => true)
  if (o.reply) R.out.push(seal(R, k, o.reply))
  if (o.broadcast) for (const [j, p] of R.peers.entries()) if (p.joined) R.out.push(seal(R, j, o.broadcast))
  const gone = o.kick !== undefined || o.left === true
  if (gone) {
    const left = depart(R.room, peer, o.kick ?? 'left')
    if (left) for (const [j, p] of R.peers.entries()) if (p.joined && R.room.peers.has(p.id)) R.out.push(seal(R, j, left))
  }
  return { kept: peer.seq !== seqWas, corrected: peer.fix !== fixWas, gone }
}

/** One tick: the snapshots every joined peer is sent; the bytes they took. */
function tick(R: Driven): number {
  tickRoom(R.room)
  const players = poses(R.room)
  let bytes = 0
  for (const [j, p] of R.peers.entries()) {
    if (!p.joined || !R.room.peers.has(p.id)) continue
    const s = seal(R, j, snapshotFor(R.room, p, players))
    R.out.push(s)
    bytes += s.length
  }
  return bytes
}

/** The first index at which two frame sequences differ, or -1. */
function firstDifference(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}

test('the room over time on the mirror: thousands of ticks with eight walkers, every input kept; heap, wasm memory and snapshot sizes flat from the first thousand ticks to the last', async (t) => {
  const TICKS = 3000, PEERS = 8
  const mirror = await Mirror.create(1337)
  // An honest page: the same city in a second mirror, walked the same way, says where its realm would have it.
  const predictor = await Mirror.create(1337)
  let now = 1000
  const R = drive(mirror, PEERS, now)
  for (let k = 0; k < PEERS; k++) {
    const o = handle(R.room, R.peers[k], { t: 'join', v: PROTOCOL_VERSION, token: 'tok', name: `Walker ${k}`, world: mirror.world }, now, () => true)
    assert.ok(o.reply && o.reply.t === 'welcome', 'welcomed')
    predictor.join(o.reply.id)
    predictor.place(o.reply.id, o.reply.you.x, o.reply.you.z, o.reply.you.y)
  }
  const g = gen(0x5eed)
  const seqs = new Array<number>(PEERS).fill(0)
  let corrected = 0
  const samples: { at: number; mem: Mem; snapshotBytes: number }[] = []
  for (let tk = 1; tk <= TICKS; tk++) {
    now += 50
    for (let k = 0; k < PEERS; k++) {
      const p = R.peers[k]
      const runs: FootRun[] = [[g.float(-RUN, RUN), g.float(-RUN, RUN), 1]]
      const claim = predictor.walk(p.id, runs)
      const r = apply(R, k, { t: 'input', seq: ++seqs[k], ack: R.room.tick, fix: p.fix, mode: 'foot', segs: runs, heading: g.float(-3, 3), claim: { x: claim.x, y: claim.y, z: claim.z } }, now)
      if (r.corrected) { corrected++; predictor.place(p.id, p.x, p.z, p.y) }
      assert.ok(!r.gone, `walker ${k} removed at tick ${tk}`)
    }
    const bytes = tick(R)
    R.out.length = 0
    if (tk === 1000 || tk === 2000 || tk === TICKS) {
      const s = { at: tk, mem: settled(), snapshotBytes: bytes }
      samples.push(s)
      t.diagnostic(`tick ${tk}: heap ${mb(s.mem.heapUsed)}, external ${mb(s.mem.external)}, ArrayBuffers ${mb(s.mem.arrayBuffers)}, snapshots ${bytes} B, bodies ${mirror.bodies}`)
    }
  }
  assert.equal(corrected, 0, 'an honest walker is never corrected')
  assert.deepEqual([mirror.counts.refused, mirror.counts.resynced, mirror.counts.kept], [0, 0, TICKS * PEERS], 'every input kept')
  assert.equal(mirror.bodies, 1 + PEERS, 'the city and one body per walker, no more')
  const [first, , last] = samples
  const heap = last.mem.heapUsed - first.mem.heapUsed, external = last.mem.external - first.mem.external, buffers = last.mem.arrayBuffers - first.mem.arrayBuffers
  assert.ok(heap < 1 * MB, `the heap grew ${mb(heap)} over ${TICKS - first.at} ticks`)
  assert.ok(external < 0.25 * MB, `external (wasm) memory grew ${mb(external)} over ${TICKS - first.at} ticks`)
  assert.ok(buffers < 0.25 * MB, `ArrayBuffers grew ${mb(buffers)} over ${TICKS - first.at} ticks`)
  assert.ok(last.snapshotBytes > first.snapshotBytes * 0.8 && last.snapshotBytes < first.snapshotBytes * 1.25, `snapshots ${first.snapshotBytes} B then ${last.snapshotBytes} B`)
})

/** The seeded script one case plays into both rooms: `ticks` of inputs (a few of them lying), chat and pings. */
function play(g: Gen, A: Driven, B: Driven, ticks: number, honest: (R: Driven, k: number, runs: FootRun[]) => { x: number; y: number; z: number }): { kept: number; corrected: number; frames: number } {
  const n = A.peers.length
  let now = 1000
  for (let k = 0; k < n; k++) {
    const join: ClientMessage = { t: 'join', v: PROTOCOL_VERSION, token: 'tok', name: `Walker ${k}`, world: A.room.authority.world }
    apply(A, k, join, now)
    apply(B, k, join, now)
  }
  const seqs = new Array<number>(n).fill(0), said = new Array<number>(n).fill(0)
  const gone = new Array<boolean>(n).fill(false)
  let kept = 0, corrected = 0
  for (let tk = 0; tk < ticks; tk++) {
    now += 50
    for (let k = 0; k < n; k++) {
      if (gone[k]) continue
      let msg: ClientMessage
      const roll = g.next()
      if (roll < 0.9) {
        const runs: FootRun[] = [[g.float(-RUN, RUN), g.float(-RUN, RUN), g.int(1, 3)]]
        const claim = honest(A, k, runs)
        // One claim in a hundred lies by a metre: a correction, the same in both rooms.
        if (g.bool(0.01)) claim.x += 1
        msg = { t: 'input', seq: ++seqs[k], ack: A.room.tick, fix: A.peers[k].fix, mode: 'foot', segs: runs, heading: g.float(-3, 3), claim }
      } else if (roll < 0.95) msg = { t: 'chat', seq: ++said[k], text: `line ${g.int(0, 1e6)}` }
      else if (roll < 0.98) msg = { t: 'ping', seq: ++said[k], kind: g.pick(['go', 'gather', 'look']), x: g.float(-10, 10), y: 0, z: g.float(-10, 10) }
      else msg = { t: 'ack', ack: A.room.tick }
      const ra = apply(A, k, msg, now)
      const rb = apply(B, k, msg, now)
      assert.deepEqual(rb, ra, `tick ${tk}, peer ${k}: the rooms judged ${msg.t} differently`)
      if (ra.kept) kept++
      if (ra.corrected) corrected++
      if (ra.gone) gone[k] = true
    }
    assert.equal(tick(B), tick(A), `tick ${tk}: snapshot bytes`)
    const at = firstDifference(A.out, B.out)
    assert.equal(at, -1, `tick ${tk}: frame ${at} differs:\n${A.out[at]?.slice(0, 300)}\n${B.out[at]?.slice(0, 300)}`)
  }
  const frames = A.out.length
  return { kept, corrected, frames }
}

test('determinism on the plane: two rooms fed one seeded random script of inputs, chat and pings write byte-identical sealed frames', () => {
  forAll('two rooms agree', { seed: 0xd00d, runs: 4 }, (g) => g.int(1, 2 ** 31), (seed) => {
    const g = gen(seed)
    const A = drive(planeAuthority(), 8, 1000), B = drive(planeAuthority(), 8, 1000)
    const r = play(g, A, B, 250, (R, k, runs) => planeStep({ x: R.peers[k].x, z: R.peers[k].z }, runs))
    assert.ok(r.kept > 1000 && r.corrected > 0, `both paths taken: ${r.kept} kept, ${r.corrected} corrected`)
    assert.ok(r.frames > 2000, `${r.frames} frames compared`)
  })
})

test('determinism on the mirror: two mirrors of one city, fed one seeded random script, write byte-identical sealed frames', async () => {
  const first = await Mirror.create(1337)
  const second = await Mirror.create(1337)
  // The honest page: a third mirror of the city, joined with the same ids (so the same spawns), walked the same way.
  const predictor = await Mirror.create(1337)
  const g = gen(0xc17)
  const A = drive(first, 8, 1000), B = drive(second, 8, 1000)
  for (const p of A.peers) predictor.join(p.id)
  // After a correction the page is put back where the room has it; the fix number says when one was made.
  const fixes = new Array<number>(8).fill(1)
  const r = play(g, A, B, 300, (R, k, runs) => {
    const p = R.peers[k]
    if (p.fix !== fixes[k]) { fixes[k] = p.fix; predictor.place(p.id, p.x, p.z, p.y) }
    const at = predictor.walk(p.id, runs)
    return { x: at.x, y: at.y, z: at.z }
  })
  assert.ok(r.kept > 1200 && r.corrected > 0, `both paths taken: ${r.kept} kept, ${r.corrected} corrected`)
  assert.equal(firstDifference(A.out, B.out), -1)
  assert.deepEqual(second.counts, first.counts, 'the two mirrors did the same work')
})
