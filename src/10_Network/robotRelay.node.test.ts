// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the robot relay (robotRelay.node.ts) over real loopback sockets with Node 22's
 * own WebSocket: the two doors refuse what they must before any socket exists (a page without a loopback Origin is
 * 403, a wrong, missing, expired or swapped token 401, another path 404, a plain request 426); a peer's hello in its
 * manifest and URDF forms appears in the page's list with its CAPS body; frames flow peer to page with the newest
 * winning each flush; the arm handshake runs page, peer, page; setpoints flow only for the page that armed, and are
 * refused with the reason for a stale seq, a wrong length, a non-finite number, an expired issuedAt and over the rate;
 * a page that closes disarms what it armed with `page-gone`; the real simulated arm (tools/robot/sim-arm.mjs) follows
 * setpoints with its lag, acknowledges them and holds when they stop; and, over a minimal MQTT broker that lives in
 * this file, the relay is a Sparkplug B host in the specification's order (CONNECT with the retained offline Will,
 * SUBSCRIBE, the retained online STATE of the same timestamp, online again over an older retained offline, offline then
 * DISCONNECT on a graceful close), a DBIRTH with a manifest is a robot, DDATA folds by alias into frames, a DCMD with
 * no seq goes out for admitted setpoints by alias or by name, NDEATH with the birth's bdSeq takes the device offline
 * and disarmed, a seq gap sends one Rebirth, DDATA before DBIRTH is ignored, a null metric holds, a refused
 * subscription or a missed PINGRESP drops the session, and a broker that drops the relay sees it back with a new
 * session. Every wait is for the relay to observe the event, never a fixed sleep.
 * What breaks if it is removed? A door could stop refusing what the gate refuses, or the broker order could drift.
 */
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { test } from 'node:test'
import { buildManifest, type JointFrame, type Manifest } from '../04_Connect_Hardware/jointState.ts'
import { encodePacket, PacketReader, SUBACK_FAILURE, topicMatches, type Packet, type QoS, type Will } from './mqttCodec.ts'
import { mintToken } from './replication.node.ts'
import { loopbackOrigin, RELAY, RELAY_SUBPROTOCOL, startRelay, SUBJECTS, type Relay, type RelayOptions } from './robotRelay.node.ts'
import {
  birthMetrics, dataMetrics, decodePayload, encodePayload, JOINT_METRICS, metric, metricValue, parseState, robotFromBirth, SPARKPLUG, stateTopic, targetsFromCommand, topic,
  type Payload, type SparkplugRobot,
} from './sparkplug.ts'
import { brokerAddress } from './sparkplugHost.node.ts'

const SECRET = 'relay-test-secret-16+'
const ORIGIN = 'http://127.0.0.1:5173'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Polls until `cond` holds, at most 3 s: the relay observes sockets on its own schedule, so the test waits for it. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let t = 0; t < 3000; t += 5) {
    if (cond()) return
    await sleep(5)
  }
  assert.ok(cond(), `still waiting: ${what}`)
}

const relay = (o: Partial<RelayOptions> = {}): Promise<Relay> => startRelay({ secret: SECRET, ...o })

type Msg = Record<string, unknown> & { t: string }

/** A page or a peer over Node's global WebSocket, recording every message the relay sends. */
interface Client {
  ws: WebSocket
  got: Msg[]
  closed: Promise<{ code: number; reason: string }>
  send(msg: unknown): void
  /** The first message of kind `t` at or after index `from` that `where` accepts, within 3 s. */
  next(t: string, from?: number, where?: (m: Msg) => boolean): Promise<Msg>
}

async function open(url: string, protocols: string[], origin: string | null): Promise<Client> {
  // Node's WebSocket takes its options as the second argument: the subprotocols, and the headers a browser would set.
  const init = origin === null ? { protocols } : { protocols, headers: { origin } }
  const ws = new WebSocket(url, init as unknown as string[])
  const got: Msg[] = []
  const closed = new Promise<{ code: number; reason: string }>((r) => { ws.onclose = (ev) => r({ code: ev.code, reason: ev.reason }) })
  ws.onmessage = (ev) => { got.push(JSON.parse(String(ev.data)) as Msg) }
  await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error(`the relay refused ${url}`)) })
  assert.equal(ws.protocol, RELAY_SUBPROTOCOL, 'the relay answers with the protocol it speaks')
  return {
    ws, got, closed,
    send: (m) => ws.send(JSON.stringify(m)),
    next: async (t, from = 0, where = () => true) => {
      let found: Msg | undefined
      await until(() => { found = got.slice(from).find((m) => m.t === t && where(m)); return found !== undefined }, `a '${t}' message`)
      return found as Msg
    },
  }
}
const page = (r: Relay, origin: string | null = ORIGIN, token = r.token(SUBJECTS.page)): Promise<Client> => open(r.url, [RELAY_SUBPROTOCOL, `auth.${token}`], origin)
const peer = (r: Relay, token = r.token(SUBJECTS.robot)): Promise<Client> => open(`${r.url}/robot`, [RELAY_SUBPROTOCOL, `auth.${token}`], null)

/** An upgrade over a raw socket: the status line the relay answers with, and the socket. */
function rawUpgrade(r: Relay, path: string, protocol: string | null, headers: string[] = []): Promise<{ socket: Socket; head: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(r.port, r.host)
    const chunks: Buffer[] = []
    socket.on('error', reject)
    const done = (): void => {
      const text = Buffer.concat(chunks).toString('latin1')
      const end = text.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', done)
      socket.off('close', done)
      resolve({ socket, head: text.slice(0, end) })
    }
    socket.on('data', (c: Buffer) => { chunks.push(c); done() })
    socket.on('close', done)
    socket.on('connect', () => {
      const proto = protocol === null ? '' : `Sec-WebSocket-Protocol: ${protocol}\r\n`
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${r.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${proto}${headers.map((h) => `${h}\r\n`).join('')}\r\n`)
    })
  })
}

// ---------------------------------------------------------------- the robots of these tests

const ARM = {
  robot: 'arm-3',
  links: [{ name: 'base' }, { name: 'upper', mass: 1 }, { name: 'fore', mass: 0.8 }, { name: 'hand', mass: 0.3 }],
  joints: [
    { name: 'shoulder', kind: 'revolute', parent: 'base', child: 'upper', axis: [0, 1, 0], lower: -1.6, upper: 1.6, effort: 12, velocity: 3 },
    { name: 'elbow', kind: 'revolute', parent: 'upper', child: 'fore', axis: [0, 1, 0], lower: -2.2, upper: 2.2, effort: 8, velocity: 3 },
    { name: 'wrist', kind: 'revolute', parent: 'fore', child: 'hand', axis: [0, 0, 1], lower: -3.1, upper: 3.1, effort: 2, velocity: 6 },
  ],
}
const CAPS = { class: 'actuator', telemetry: ['joints'], actuation: ['servo'] }
const URDF = `<?xml version="1.0"?>
<robot name="urdf-arm">
  <link name="base"/>
  <link name="l1"><inertial><mass value="1"/></inertial></link>
  <joint name="j1" type="revolute">
    <parent link="base"/><child link="l1"/><axis xyz="0 0 1"/>
    <limit lower="-1" upper="1" effort="5" velocity="2"/>
  </joint>
</robot>`
function armManifest(): Manifest {
  const r = buildManifest(ARM.robot, ARM.links, ARM.joints)
  assert.ok(r.ok)
  return r.value
}
const frame = (seq: number, q: number[], extra: Partial<JointFrame> = {}): JointFrame => ({ stamp: 1000 + seq, seq, q, qd: [0, 0, 0], tau: [0, 0, 0], ...extra })
const setpoints = (seq: number, q: number[] = [0.3, -0.2, 0.5], o: Record<string, unknown> = {}): Record<string, unknown> => ({ seq, issuedAt: Date.now(), ttlMs: 200, q, qd: [], tau: [], ...o })

/** Sends `msg` from `c` and returns the reason of the refusal that answers it. */
async function refusal(c: Client, msg: unknown): Promise<string> {
  const from = c.got.length
  c.send(msg)
  return (await c.next('refused', from)).why as string
}

/** A peer that has said hello with the three-joint arm and been welcomed. */
async function armPeer(r: Relay, caps: unknown = CAPS): Promise<{ c: Client; id: string }> {
  const c = await peer(r)
  c.send({ t: 'hello', v: 1, manifest: ARM, caps })
  const w = await c.next('welcome')
  return { c, id: w.id as string }
}

// ---------------------------------------------------------------- the doors

test('the doors: a page needs a loopback Origin (403 without one) and the page token, a peer the robot token (401 otherwise); no socket is upgraded for a refusal; another path is 404, a plain request 426', async () => {
  for (const good of ['http://127.0.0.1:5173', 'https://127.0.0.1', 'http://localhost:4180', 'https://localhost', 'http://[::1]:1', 'HTTP://LOCALHOST:80']) assert.ok(loopbackOrigin(good), good)
  for (const bad of [undefined, '', 'null', 'http://192.0.2.9:3000', 'http://127.0.0.1.example', 'file://', 'ws://127.0.0.1:1', 'http://127.0.0.1/path', 'http://user@127.0.0.1', 42, 'http://localhost:5173 '.repeat(20)]) assert.equal(loopbackOrigin(bad), false, String(bad))
  const r = await relay()
  try {
    const pageAuth = `${RELAY_SUBPROTOCOL}, auth.${r.token(SUBJECTS.page)}`
    const robotAuth = `${RELAY_SUBPROTOCOL}, auth.${r.token(SUBJECTS.robot)}`
    const head = async (path: string, protocol: string | null, headers: string[] = []): Promise<string> => {
      const u = await rawUpgrade(r, path, protocol, headers)
      u.socket.destroy()
      return u.head.split('\r\n')[0]
    }
    // The Origin rule: absent or null is refused, a loopback origin of either scheme and any port passes.
    assert.equal(await head('/', pageAuth), 'HTTP/1.1 403 Forbidden', 'no Origin')
    assert.equal(await head('/', pageAuth, ['Origin: null']), 'HTTP/1.1 403 Forbidden', 'Origin null')
    assert.equal(await head('/', pageAuth, ['Origin: http://192.0.2.9:3000']), 'HTTP/1.1 403 Forbidden', 'an origin off this machine')
    assert.equal(await head('/', pageAuth, ['Origin: http://127.0.0.1:5173']), 'HTTP/1.1 101 Switching Protocols')
    assert.equal(await head('/', pageAuth, ['Origin: https://localhost']), 'HTTP/1.1 101 Switching Protocols')
    assert.equal(await head('/', pageAuth, ['Origin: http://[::1]:4180']), 'HTTP/1.1 101 Switching Protocols')
    // The tokens: the page's opens `/` alone, the robot's `/robot` alone; nothing else opens either.
    assert.equal(await head('/', null, ['Origin: http://127.0.0.1']), 'HTTP/1.1 401 Unauthorized', 'no subprotocol')
    assert.equal(await head('/', RELAY_SUBPROTOCOL, ['Origin: http://127.0.0.1']), 'HTTP/1.1 401 Unauthorized', 'no token')
    assert.equal(await head('/', robotAuth, ['Origin: http://127.0.0.1']), 'HTTP/1.1 401 Unauthorized', 'the robot token on the page door')
    assert.equal(await head('/robot', pageAuth), 'HTTP/1.1 401 Unauthorized', 'the page token on the peer door')
    assert.equal(await head('/robot', `${RELAY_SUBPROTOCOL}, auth.${mintToken(SECRET, SUBJECTS.robot, Date.now() - 1)}`), 'HTTP/1.1 401 Unauthorized', 'expired')
    assert.equal(await head('/robot', `${RELAY_SUBPROTOCOL}, auth.${mintToken('another secret 16', SUBJECTS.robot, Date.now() + 60_000)}`), 'HTTP/1.1 401 Unauthorized', 'another secret')
    assert.equal(await head('/robot', `${robotAuth.slice(0, -2)}`), 'HTTP/1.1 401 Unauthorized', 'tampered')
    assert.equal(await head('/robot', robotAuth), 'HTTP/1.1 101 Switching Protocols')
    assert.equal(await head('/elsewhere', robotAuth), 'HTTP/1.1 404 Not Found')
    assert.equal(await head('/robot', robotAuth, ['Sec-WebSocket-Version: 12']).catch(() => 'reset'), 'HTTP/1.1 400 Bad Request')
    await until(() => r.connections() === 0, 'the probes that were upgraded let go')
    const s = r.stats()
    assert.equal(s.forbidden, 3)
    assert.equal(s.unauthorized, 7)
    assert.equal(s.robots, 0)
    // A WebSocket refused is a failure, never an open socket: Node's sends no Origin, so the page door turns it away.
    await assert.rejects(page(r, null), /refused/)
    await assert.rejects(peer(r, r.token(SUBJECTS.page)), /refused/)
    await assert.rejects(page(r, 'http://192.0.2.9'), /refused/)
    assert.equal(r.connections(), 0)
    // A plain HTTP request is told to upgrade.
    const status = await new Promise<number>((resolve, reject) => { request({ host: r.host, port: r.port, path: '/' }, (res) => { res.resume(); resolve(res.statusCode ?? 0) }).on('error', reject).end() })
    assert.equal(status, 426)
  } finally {
    await r.close()
  }
})

// ---------------------------------------------------------------- peers, hello, frames

test('peers: a hello with a manifest or a URDF is welcomed with an id and the joint order, listed to the page with its CAPS body; frames flow to the page with the newest winning each flush; bad hellos close the peer with the reason', async () => {
  const log: string[] = []
  const r = await relay({ flushHz: 10, log: (l) => log.push(l) })
  try {
    const a = await armPeer(r)
    assert.equal(a.id, 'ws:1')
    const welcome = a.c.got[0]
    assert.deepEqual(welcome.order, ['shoulder', 'elbow', 'wrist'])
    assert.equal((welcome.manifest as Manifest).robot, 'arm-3')
    const b = await peer(r)
    b.send({ t: 'hello', v: 1, urdf: URDF })
    const wb = await b.next('welcome')
    assert.equal(wb.id, 'ws:2')
    assert.deepEqual(wb.order, ['j1'])
    // The page's hello lists both, each with what the gate will read.
    const p = await page(r)
    const hello = await p.next('hello')
    assert.deepEqual(hello.relay, { v: 1, mqtt: null })
    const robots = hello.robots as { id: string; name: string; via: string; manifest: Manifest; caps: unknown }[]
    assert.deepEqual(robots.map((x) => [x.id, x.name, x.via]), [['ws:1', 'arm-3', 'ws'], ['ws:2', 'urdf-arm', 'ws']])
    assert.deepEqual(robots[0].caps, CAPS, 'the CAPS body as the peer declared it')
    assert.equal(robots[1].caps, null, 'no caps: a sensor')
    assert.equal(robots[1].manifest.movable.length, 1)
    // A robot that joins or leaves later is announced.
    const c = await armPeer(r, null)
    const joined = await p.next('robot', 0, (m) => m.id === 'ws:3')
    assert.equal((joined.manifest as Manifest).robot, 'arm-3')
    assert.equal(joined.caps, null)
    c.c.ws.close(1000, 'done')
    await p.next('robot', 0, (m) => m.id === 'ws:3' && m.gone === true)
    // Three frames in one burst: the page sees the newest (the flush runs ten times a second here), never the others.
    a.c.send({ t: 'state', frame: frame(1, [0.1, 0, 0]) })
    a.c.send({ t: 'state', frame: frame(2, [0.2, 0, 0]) })
    a.c.send({ t: 'state', frame: frame(3, [0.3, 0, 0], { ack: 0 }) })
    const st = await p.next('state')
    assert.equal(st.id, 'ws:1')
    assert.deepEqual(st.frame, { stamp: 1003, seq: 3, q: [0.3, 0, 0], qd: [0, 0, 0], tau: [0, 0, 0], ack: 0 })
    await sleep(120)
    assert.deepEqual(p.got.filter((m) => m.t === 'state').map((m) => (m.frame as JointFrame).seq), [3], 'the older frames never reached the page')
    // A frame the judge refuses is counted and dropped.
    a.c.send({ t: 'state', frame: { stamp: 1, seq: 4, q: [0, 0], qd: [], tau: [] } })
    await until(() => (r.stats().refused['state: q has 2 entries for 3 movable joints'] ?? 0) === 1, 'the bad frame counted')
    await sleep(120)
    assert.equal(p.got.filter((m) => m.t === 'state').length, 1)
    assert.equal(r.stats().frames, 3)
    // The page's echo comes straight back.
    p.send({ t: 'echo', seq: 7, at: 123.5 })
    assert.deepEqual(await p.next('echo'), { t: 'echo', seq: 7, at: 123.5 })
    // Bad hellos: the wrong version, no manifest, a manifest the judge refuses, a CAPS body the gate refuses, and a peer that speaks before its hello.
    const refused = async (first: unknown): Promise<{ code: number; reason: string }> => {
      const x = await peer(r)
      x.send(first)
      return x.closed
    }
    assert.deepEqual(await refused({ t: 'hello', v: 2, manifest: ARM }), { code: 4002, reason: 'hello: v must be 1' })
    assert.deepEqual(await refused({ t: 'hello', v: 1 }), { code: 4002, reason: 'hello: a manifest or a urdf' })
    assert.match((await refused({ t: 'hello', v: 1, manifest: { robot: 'x', links: [], joints: [] } })).reason, /^hello: a robot needs at least one link/)
    assert.match((await refused({ t: 'hello', v: 1, urdf: '<robot name="r"><link name="a"/><link name="b"/></robot>' })).reason, /^hello: more than one root link/)
    assert.match((await refused({ t: 'hello', v: 1, manifest: ARM, caps: { class: 'toaster' } })).reason, /^hello: caps: unknown device class/)
    assert.deepEqual(await refused({ t: 'state', frame: frame(1, [0, 0, 0]) }), { code: 4002, reason: 'hello first' })
    assert.deepEqual(await refused('not json'), { code: 1003, reason: 'a text frame must be a JSON object with a string t' })
    const bin = await peer(r)
    bin.ws.send(new Uint8Array([1, 2, 3]))
    assert.deepEqual(await bin.closed, { code: 1003, reason: 'text frames only' })
    await until(() => r.connections() === 3, 'the refused peers are gone')
    assert.equal(r.robots().length, 2)
    assert.ok(log.some((l) => /robot ws:1 \(arm-3, ws, 3 joints, servo\) joined/.test(l)))
  } finally {
    await r.close()
  }
})

// ---------------------------------------------------------------- the second gate

test('arming and the second gate: page arm, peer arm, peer armed, page armed; setpoints flow only for the page that armed, refused with the reason otherwise; a closing page disarms with page-gone', async () => {
  const r = await relay()
  try {
    const a = await armPeer(r)
    const b = await armPeer(r)
    const sensor = await armPeer(r, null)
    const p1 = await page(r)
    const p2 = await page(r)
    // Before any arm: refused, and said so.
    p1.send({ t: 'targets', id: a.id, setpoints: setpoints(1) })
    assert.deepEqual(await p1.next('refused'), { t: 'refused', id: a.id, why: 'targets: not armed by this page' })
    assert.equal(await refusal(p1, { t: 'arm', id: 'ws:9', nonce: 'n' }), 'arm: unknown robot')
    assert.equal(await refusal(p1, { t: 'arm', id: sensor.id, nonce: 'n' }), 'arm: servo not declared')
    assert.equal(await refusal(p1, { t: 'arm', id: a.id, nonce: '' }), 'arm: a nonce of 1 to 64 characters')
    // The handshake.
    p1.send({ t: 'arm', id: a.id, nonce: 'n-1' })
    assert.deepEqual(await a.c.next('arm'), { t: 'arm', nonce: 'n-1' })
    assert.equal(await refusal(p1, { t: 'targets', id: a.id, setpoints: setpoints(1) }), 'targets: not armed', 'the peer has not echoed yet')
    a.c.send({ t: 'armed', nonce: 'wrong' })
    await until(() => (r.stats().refused['armed: no arm with that nonce'] ?? 0) === 1, 'the wrong echo counted')
    a.c.send({ t: 'armed', nonce: 'n-1' })
    assert.deepEqual(await p1.next('armed'), { t: 'armed', id: a.id, nonce: 'n-1' })
    assert.deepEqual(await p2.next('armed'), { t: 'armed', id: a.id, nonce: 'n-1' }, 'a watching page sees it too')
    // Setpoints flow, as the relay judged them.
    const sp = setpoints(1, [0.3, -0.2, 0.5], { tau: [1, 1, 1] })
    p1.send({ t: 'targets', id: a.id, setpoints: sp })
    const out = await a.c.next('targets')
    assert.deepEqual(out.setpoints, sp)
    assert.equal(r.stats().accepted, 1)
    // The refusals, each with its reason.
    const refusedFrom = p1.got.length
    const cases: [Record<string, unknown>, string][] = [
      [setpoints(1), 'targets: stale seq'],
      [setpoints(0), 'targets: stale seq'],
      [setpoints(2, [0.1, 0.2]), 'targets: q has 2 entries for 3 movable joints'],
      [setpoints(2, [0.1, null as unknown as number, 0.3]), 'targets: q[1] is not a finite number'],
      [setpoints(2, [0, 0, 0], { qd: [1, 2] }), 'targets: qd has 2 entries for 3 movable joints'],
      [setpoints(2, [0, 0, 0], { issuedAt: Date.now() - 1000, ttlMs: 100 }), 'targets: expired issuedAt'],
      [setpoints(2, [0, 0, 0], { issuedAt: Date.now() + 1000 }), 'targets: issuedAt ahead of the relay clock'],
      [setpoints(2, [0, 0, 0], { ttlMs: 0 }), 'targets: targets need issuedAt (ms) and a positive ttlMs'],
      [{ seq: 2, issuedAt: Date.now(), ttlMs: 100, q: [0, 0, 0], qd: [], tau: [], pad: 'x'.repeat(RELAY.message) }, 'targets: over 16 KiB'],
    ]
    for (const [s] of cases) p1.send({ t: 'targets', id: a.id, setpoints: s })
    await until(() => p1.got.slice(refusedFrom).filter((m) => m.t === 'refused').length === cases.length, 'every refusal answered')
    assert.deepEqual(p1.got.slice(refusedFrom).filter((m) => m.t === 'refused').map((m) => m.why), cases.map(([, why]) => why))
    assert.equal(a.c.got.filter((m) => m.t === 'targets').length, 1, 'none of them reached the peer')
    // Over the rate: a fresh arm on the second robot, then thirty in one burst: twenty-five pass, five are refused.
    p1.send({ t: 'arm', id: b.id, nonce: 'n-2' })
    await b.c.next('arm')
    b.c.send({ t: 'armed', nonce: 'n-2' })
    await p1.next('armed', 0, (m) => m.id === b.id)
    const burstFrom = p1.got.length
    for (let i = 1; i <= 30; i++) p1.send({ t: 'targets', id: b.id, setpoints: setpoints(i) })
    await until(() => b.c.got.filter((m) => m.t === 'targets').length === RELAY.targetsPerSecond && p1.got.slice(burstFrom).filter((m) => m.t === 'refused').length === 30 - RELAY.targetsPerSecond, 'the burst judged')
    assert.ok(p1.got.slice(burstFrom).filter((m) => m.t === 'refused').every((m) => m.why === 'targets: over rate' && m.id === b.id))
    assert.deepEqual(b.c.got.filter((m) => m.t === 'targets').map((m) => (m.setpoints as { seq: number }).seq), Array.from({ length: 25 }, (_, i) => i + 1))
    // Another page may watch, not arm nor steer, while this one holds an arm.
    assert.equal(await refusal(p2, { t: 'arm', id: a.id, nonce: 'n-3' }), 'arm: another page is arming')
    assert.equal(await refusal(p2, { t: 'targets', id: a.id, setpoints: setpoints(5) }), 'targets: not armed by this page')
    assert.equal(await refusal(p2, { t: 'disarm', id: a.id, cause: 'mine' }), 'disarm: not armed by this page')
    assert.equal(a.c.got.filter((m) => m.t === 'disarm').length, 0)
    // The beat and the ack ride through to every page.
    a.c.send({ t: 'beat', n: 3 })
    a.c.send({ t: 'ack', seq: 1 })
    assert.deepEqual(await p2.next('beat'), { t: 'beat', id: a.id, n: 3 })
    assert.deepEqual(await p1.next('ack'), { t: 'ack', id: a.id, seq: 1 })
    // The page's own disarm: the peer is told the cause; the page asked, so it is not told again.
    p1.send({ t: 'disarm', id: b.id, cause: 'done' })
    assert.deepEqual(await b.c.next('disarm'), { t: 'disarm', cause: 'done' })
    await sleep(30)
    assert.equal(p1.got.filter((m) => m.t === 'disarm').length, 0)
    assert.equal(r.stats().disarmed, 1)
    // The page goes: everything it armed is told page-gone.
    p1.ws.close(1000, 'leaving')
    assert.deepEqual(await a.c.next('disarm'), { t: 'disarm', cause: 'page-gone' })
    await until(() => r.stats().disarmed === 2 && r.stats().pages === 1, 'the page gone')
    // Now the other page may arm; and a peer that leaves while armed is reported gone and disarmed to that page.
    p2.send({ t: 'arm', id: a.id, nonce: 'n-4' })
    assert.deepEqual(await a.c.next('arm', 0, (m) => m.nonce === 'n-4'), { t: 'arm', nonce: 'n-4' })
    a.c.send({ t: 'armed', nonce: 'n-4' })
    await p2.next('armed', 0, (m) => m.nonce === 'n-4')
    a.c.ws.close(1000, 'bye')
    await p2.next('robot', 0, (m) => m.id === a.id && m.gone === true)
    const told = await p2.next('disarm')
    assert.equal(told.id, a.id)
    assert.equal(r.stats().disarmed, 3)
    assert.equal(r.robots().length, 2)
    // The relay closes: the pages are closed with 1001, the peers disarmed and closed.
    const closing = r.close()
    assert.deepEqual(await p2.closed, { code: 1001, reason: 'relay closing' })
    assert.deepEqual(await b.c.closed, { code: 1001, reason: 'relay closing' })
    await closing
    assert.equal(r.connections(), 0)
    await assert.rejects(page(r), 'nothing listens after close')
  } finally {
    await r.close()
  }
})

// ---------------------------------------------------------------- the simulated arm

test('the simulated arm (tools/robot/sim-arm.mjs): joins with its manifest and caps, is armed, follows setpoints as a lag with a delay and acknowledges them, beats, and holds when they stop', async () => {
  // The arm is plain JavaScript (tools/ carries no types); a computed specifier keeps the typecheck off it.
  const SIM: string = '../../tools/robot/sim-arm.mjs'
  const { start, MANIFEST, RULE } = (await import(SIM)) as {
    start(url: string, token: string, o?: Record<string, unknown>): { opened: Promise<void>; closed: Promise<{ code: number }>; state(): { q: number[]; qd: number[]; armed: boolean; holding: boolean; ack?: number }; close(): void }
    MANIFEST: { robot: string }
    RULE: { holdMs: number; beatMs: number }
  }
  assert.equal(RULE.holdMs, 500)
  const r = await relay()
  const arm = start(`${r.url}/robot`, r.token(SUBJECTS.robot), { tauMs: 30, delayMs: 20, hz: 100 })
  try {
    await arm.opened
    const p = await page(r)
    const hello = await p.next('hello')
    await until(() => r.robots().length === 1, 'the arm listed')
    const listed = r.robots()[0]
    assert.equal(listed.name, MANIFEST.robot)
    assert.deepEqual(listed.caps, { class: 'actuator', telemetry: ['joints'], actuation: ['servo'] })
    assert.ok((hello.robots as unknown[]).length === 1 || p.got.some((m) => m.t === 'robot'))
    const id = listed.id
    p.send({ t: 'arm', id, nonce: 'sim-1' })
    assert.deepEqual(await p.next('armed'), { t: 'armed', id, nonce: 'sim-1' })
    // Setpoints every 40 ms for a while: the arm follows with its lag and says which seq it applied.
    const goal = [0.4, -0.2, 0.8]
    let seq = 0
    for (let i = 0; i < 12; i++) {
      p.send({ t: 'targets', id, setpoints: { seq: ++seq, issuedAt: Date.now(), ttlMs: 250, q: goal, qd: [], tau: [] } })
      await sleep(40)
    }
    await p.next('ack', 0, (m) => m.seq === seq)
    await until(() => { const s = arm.state(); return !s.holding && s.q.every((v, i) => Math.abs(v - goal[i]) < 0.02) }, 'the arm settled near the goal while fresh')
    const states = p.got.filter((m) => m.t === 'state' && m.id === id).map((m) => m.frame as JointFrame)
    assert.ok(states.length > 10, `${states.length} frames reached the page`)
    assert.ok(states.some((f) => f.qd.some((v) => v !== 0)), 'it moved')
    assert.ok(states.some((f) => f.ack === seq), 'its frames carry the ack')
    assert.ok(p.got.some((m) => m.t === 'beat' && m.id === id), 'it beats while armed')
    // No fresh setpoints: after the hold, q is frozen and q̇ and τ read 0.
    await until(() => arm.state().holding, 'the arm holds')
    const holdFrom = p.got.length
    await until(() => p.got.slice(holdFrom).filter((m) => m.t === 'state').length >= 3, 'frames while holding')
    const held = p.got.slice(holdFrom).filter((m) => m.t === 'state').map((m) => m.frame as JointFrame)
    assert.ok(held.every((f) => f.qd.every((v) => v === 0) && f.tau.every((v) => v === 0)), 'no motion and no effort reported')
    assert.deepEqual(held[0].q, held.at(-1)!.q, 'q frozen')
    // The page leaves: the arm is disarmed (page-gone) and its beats stop.
    p.ws.close(1000, 'done')
    await until(() => !arm.state().armed, 'the arm disarmed')
    assert.equal(r.stats().disarmed, 1)
  } finally {
    arm.close()
    await r.close()
  }
})

// ---------------------------------------------------------------- an MQTT broker for the tests

type Publish = Extract<Packet, { type: 'publish' }>
interface BrokerClient { socket: Socket; id: string; subs: { filter: string; qos: QoS }[]; will: Will | null; disconnected: boolean; cleanSession: boolean }
interface Broker {
  port: number
  /** Every packet received, with the client id of its sender (the CONNECT's). */
  log: { from: string; packet: Packet }[]
  clients: Map<string, BrokerClient>
  retained: Map<string, { payload: Uint8Array; qos: QoS }>
  /** A message from the broker itself (a retained one another host left, say). */
  publish(t: string, payload: Uint8Array, o?: { qos?: QoS; retain?: boolean }): void
  /** Destroys a client's socket without a DISCONNECT: its Will fires. */
  drop(clientId: string): void
  close(): Promise<void>
}

/** The least of MQTT 3.1.1 a Sparkplug host needs: CONNECT, SUBSCRIBE, PUBLISH fan-out, retained messages, the Will, PINGREQ. */
function startBroker(o: { refuse?: string[]; mutePing?: boolean } = {}): Promise<Broker> {
  const clients = new Map<string, BrokerClient>()
  const retained = new Map<string, { payload: Uint8Array; qos: QoS }>()
  const log: { from: string; packet: Packet }[] = []
  const sockets = new Set<Socket>()
  let ids = 0
  const send = (c: BrokerClient, p: Packet): void => { if (!c.socket.destroyed) c.socket.write(encodePacket(p)) }
  const deliver = (t: string, payload: Uint8Array, qos: QoS, retain: boolean): void => {
    if (retain) {
      if (payload.length === 0) retained.delete(t)
      else retained.set(t, { payload, qos })
    }
    for (const c of clients.values()) {
      const matching = c.subs.filter((s) => topicMatches(s.filter, t))
      if (matching.length === 0) continue
      const q = Math.min(qos, Math.max(...matching.map((s) => s.qos))) as QoS
      send(c, { type: 'publish', topic: t, payload, qos: q, retain: false, dup: false, ...(q > 0 ? { packetId: (ids = (ids % 65_535) + 1) } : {}) })
    }
  }
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    const reader = new PacketReader()
    let c: BrokerClient | null = null
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk: Buffer) => {
      for (const p of reader.feed(chunk)) {
        log.push({ from: c?.id ?? '?', packet: p })
        switch (p.type) {
          case 'connect':
            c = { socket, id: p.clientId, subs: [], will: p.will ?? null, disconnected: false, cleanSession: p.cleanSession }
            clients.set(p.clientId, c)
            send(c, { type: 'connack', sessionPresent: false, code: 0 })
            break
          case 'subscribe': {
            if (!c) break
            const codes = p.topics.map((t) => (o.refuse?.includes(t.filter) ? SUBACK_FAILURE : t.qos))
            for (const [i, t] of p.topics.entries()) if (codes[i] !== SUBACK_FAILURE) c.subs.push(t)
            send(c, { type: 'suback', packetId: p.packetId, codes })
            for (const [t, m] of retained) {
              const matching = c.subs.filter((s) => topicMatches(s.filter, t))
              if (matching.length === 0) continue
              const q = Math.min(m.qos, Math.max(...matching.map((s) => s.qos))) as QoS
              send(c, { type: 'publish', topic: t, payload: m.payload, qos: q, retain: true, dup: false, ...(q > 0 ? { packetId: (ids = (ids % 65_535) + 1) } : {}) })
            }
            break
          }
          case 'publish':
            if (!c) break
            if (p.qos === 1 && p.packetId !== undefined) send(c, { type: 'puback', packetId: p.packetId })
            deliver(p.topic, p.payload, p.qos, p.retain)
            break
          case 'pingreq':
            if (c && !o.mutePing) send(c, { type: 'pingresp' })
            break
          case 'disconnect':
            if (c) c.disconnected = true
            break
          default:
            break
        }
      }
      if (reader.error) socket.destroy()
    })
    socket.on('close', () => {
      sockets.delete(socket)
      if (!c) return
      if (clients.get(c.id) === c) clients.delete(c.id)
      if (c.will && !c.disconnected) deliver(c.will.topic, c.will.payload, c.will.qos, c.will.retain)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const a = server.address()
      resolve({
        port: typeof a === 'object' && a ? a.port : 0,
        log, clients, retained,
        publish: (t, payload, opt = {}) => deliver(t, payload, opt.qos ?? 0, opt.retain ?? false),
        drop: (id) => clients.get(id)?.socket.destroy(),
        close: () => new Promise<void>((done) => { for (const s of sockets) s.destroy(); server.close(() => done()) }),
      })
    })
  })
}

/** A Sparkplug edge node of the tests: one MQTT client that publishes births and data and reads the commands it is sent. */
interface Edge {
  got: Publish[]
  publish(t: string, payload: Uint8Array, qos?: QoS): void
  subscribe(filters: string[]): Promise<void>
  next(where: (p: Publish) => boolean, from?: number): Promise<Publish>
  close(): void
}
function connectEdge(port: number, clientId: string): Promise<Edge> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    const reader = new PacketReader()
    const got: Publish[] = []
    const waiting = new Map<number, () => void>()
    let ids = 0
    const send = (p: Packet): void => { socket.write(encodePacket(p)) }
    socket.on('error', reject)
    socket.on('connect', () => send({ type: 'connect', clientId, keepAlive: 60, cleanSession: true, protocolLevel: 4 }))
    socket.on('data', (chunk: Buffer) => {
      for (const p of reader.feed(chunk)) {
        if (p.type === 'connack') {
          resolve({
            got,
            publish: (t, payload, qos = 0) => send({ type: 'publish', topic: t, payload, qos, retain: false, dup: false, ...(qos > 0 ? { packetId: ++ids } : {}) }),
            subscribe: (filters) => new Promise<void>((ok) => { const id = ++ids; waiting.set(id, ok); send({ type: 'subscribe', packetId: id, topics: filters.map((f) => ({ filter: f, qos: 1 })) }) }),
            next: async (where, from = 0) => {
              let found: Publish | undefined
              await until(() => { found = got.slice(from).find(where); return found !== undefined }, 'a publish to the edge')
              return found as Publish
            },
            close: () => { send({ type: 'disconnect' }); socket.end() },
          })
        } else if (p.type === 'suback') waiting.get(p.packetId)?.()
        else if (p.type === 'publish') {
          if (p.qos === 1 && p.packetId !== undefined) send({ type: 'puback', packetId: p.packetId })
          got.push(p)
        }
      }
    })
  })
}

const bytes = (p: Payload): Uint8Array => encodePayload(p)
const utf8 = new TextDecoder()

test('Sparkplug B over the in-test broker: the session in the specification\'s order, births as robots, data as frames, DCMDs without seq, Rebirth once per gap, deaths, null metrics, and a new session after the broker drops the relay', async () => {
  assert.deepEqual(brokerAddress('mqtt://127.0.0.1:1884', false), { host: '127.0.0.1', port: 1884 })
  assert.deepEqual(brokerAddress('mqtt://localhost', false), { host: 'localhost', port: 1883 })
  assert.deepEqual(brokerAddress('mqtt://[::1]:1883', false), { host: '::1', port: 1883 })
  assert.throws(() => brokerAddress('mqtt://192.0.2.9:1883', false), /off this machine/)
  assert.deepEqual(brokerAddress('mqtt://192.0.2.9:1883', true), { host: '192.0.2.9', port: 1883 })
  assert.throws(() => brokerAddress('mqtts://127.0.0.1', false), /plain TCP/)
  assert.throws(() => brokerAddress('nonsense', false), /not a URL/)

  const broker = await startBroker()
  const log: string[] = []
  const CLIENT = 'agentcity-0badf00d'
  const r = await relay({ log: (l) => log.push(l), mqtt: { url: `mqtt://127.0.0.1:${broker.port}`, clientId: CLIENT, backoff: { minMs: 20, maxMs: 40 } } })
  const STATE = stateTopic('agentcity')
  const packets = (): Packet[] => broker.log.filter((e) => e.from === CLIENT || (e.packet.type === 'connect' && e.packet.clientId === CLIENT)).map((e) => e.packet)
  const edge = await connectEdge(broker.port, 'edge-1')
  try {
    // The order: CONNECT with the retained offline Will, SUBSCRIBE to spBv1.0/# and the STATE topic, the retained online STATE with the Will's timestamp.
    await until(() => packets().filter((p) => p.type === 'publish').length >= 1, 'the online certificate')
    const [c0, s0, p0] = packets()
    assert.equal(c0.type, 'connect')
    assert.ok(c0.type === 'connect' && c0.cleanSession && c0.keepAlive === 30 && c0.will?.topic === STATE && c0.will.qos === 1 && c0.will.retain)
    const willState = parseState((c0 as Extract<Packet, { type: 'connect' }>).will!.payload)
    assert.ok(willState && willState.online === false)
    assert.ok(s0.type === 'subscribe' && s0.topics.map((t) => t.filter).join(' ') === `${SPARKPLUG.namespace}/# ${STATE}` && s0.topics[1].qos === 1)
    assert.ok(p0.type === 'publish' && p0.topic === STATE && p0.qos === 1 && p0.retain)
    assert.deepEqual(parseState((p0 as Publish).payload), { online: true, timestamp: willState!.timestamp }, 'the same T as the Will')
    const T1 = willState!.timestamp
    await until(() => r.stats().mqtt?.online === true, 'the relay online')
    const p = await page(r)
    assert.deepEqual((await p.next('hello')).relay, { v: 1, mqtt: 'agentcity' })
    // A retained offline certificate older than this session (left by an earlier life): online again, and the QoS 1 delivery acknowledged.
    const before = packets().filter((x) => x.type === 'publish' && x.topic === STATE).length
    broker.publish(STATE, new TextEncoder().encode(JSON.stringify({ online: false, timestamp: T1 - 1 })), { qos: 1, retain: true })
    await until(() => packets().filter((x) => x.type === 'publish' && x.topic === STATE).length === before + 1, 'online published again')
    assert.deepEqual(parseState((packets().filter((x) => x.type === 'publish' && x.topic === STATE).at(-1) as Publish).payload), { online: true, timestamp: T1 })
    assert.ok(packets().some((x) => x.type === 'puback'), 'the QoS 1 delivery was acknowledged')
    // The edge node: DDATA before any DBIRTH is ignored.
    await edge.subscribe([topic('g1', 'NCMD', 'n1'), `${SPARKPLUG.namespace}/g1/DCMD/n1/#`, STATE])
    const m = armManifest()
    const t0 = Date.now()
    edge.publish(topic('g1', 'DDATA', 'n1', 'arm'), bytes({ timestamp: t0, metrics: [metric('Joints/shoulder/q', 'Double', 1, t0)], seq: 1 }))
    await until(() => (r.stats().mqtt?.ignored ?? 0) === 1, 'the early DDATA ignored')
    assert.equal(r.robots().length, 0)
    // NBIRTH, then a DBIRTH with the manifest, aliases, the gate's words and the CAPS body: a robot.
    edge.publish(topic('g1', 'NBIRTH', 'n1'), bytes({ timestamp: t0, metrics: [metric(SPARKPLUG.bdSeq, 'Int64', 0, t0), metric(SPARKPLUG.rebirth, 'Boolean', false, t0)], seq: 0 }))
    const birth = birthMetrics(m, frame(0, [0.1, 0.2, 0.3]), t0, { aliases: true, armable: true, caps: JSON.stringify(CAPS) })
    const sp = robotFromBirth(birth)
    assert.ok(sp && sp.ok)
    const robot: SparkplugRobot = sp.value
    edge.publish(topic('g1', 'DBIRTH', 'n1', 'arm'), bytes({ timestamp: t0, metrics: birth, seq: 1 }))
    const born = await p.next('robot', 0, (x) => x.id === 'g1/n1/arm')
    assert.equal(born.via, 'mqtt')
    assert.equal(born.name, 'arm-3')
    assert.deepEqual(born.caps, CAPS, 'the CAPS body out of Joints/Caps')
    assert.deepEqual((born.manifest as Manifest).movable, [0, 1, 2])
    const first = await p.next('state', 0, (x) => x.id === 'g1/n1/arm')
    assert.deepEqual((first.frame as JointFrame).q, [0.1, 0.2, 0.3], 'the birth\'s own values are the first frame')
    // A second device of the same node, born without aliases: commands to it go by name.
    const plainBirth = birthMetrics(m, null, t0, { armable: true, caps: JSON.stringify(CAPS) })
    const plain = robotFromBirth(plainBirth)
    assert.ok(plain && plain.ok)
    edge.publish(topic('g1', 'DBIRTH', 'n1', 'named'), bytes({ timestamp: t0, metrics: plainBirth, seq: 2 }))
    await p.next('robot', 0, (x) => x.id === 'g1/n1/named')
    // DDATA by alias, report by exception: one joint moved, the rest keep the birth's values. The node's seq goes on from the births.
    let seq = 2
    const data = (ms: ReturnType<typeof dataMetrics>, s = ++seq): void => edge.publish(topic('g1', 'DDATA', 'n1', 'arm'), bytes({ timestamp: Date.now(), metrics: ms, seq: s }))
    data([{ alias: 5, value: { kind: 'double', value: 0.25 } }])
    const moved = await p.next('state', p.got.indexOf(first) + 1, (x) => x.id === 'g1/n1/arm')
    assert.deepEqual((moved.frame as JointFrame).q, [0.1, 0.25, 0.3])
    assert.equal((moved.frame as JointFrame).seq, 1, 'the relay\'s own count')
    // A null metric: the frame reads NaN, is refused, and the twin holds (no new state) until the joint is reported again.
    const statesBefore = p.got.filter((x) => x.t === 'state' && x.id === 'g1/n1/arm').length
    data([{ alias: 2, isNull: true }])
    await until(() => (r.stats().refused['state: q[0] is not a finite number'] ?? 0) === 1, 'the null frame refused')
    await sleep(40)
    assert.equal(p.got.filter((x) => x.t === 'state' && x.id === 'g1/n1/arm').length, statesBefore, 'nothing new reached the page')
    data([{ alias: 2, value: { kind: 'double', value: 0.11 } }])
    const healed = await p.next('state', p.got.length, (x) => x.id === 'g1/n1/arm')
    assert.deepEqual((healed.frame as JointFrame).q, [0.11, 0.25, 0.3])
    // Arm: a DCMD writes the nonce to Joints/Arm by alias; the device echoes it in DDATA; the page sees armed.
    p.send({ t: 'arm', id: 'g1/n1/arm', nonce: 'mq-1' })
    const armCmd = await edge.next((x) => x.topic === topic('g1', 'DCMD', 'n1', 'arm'))
    assert.equal(armCmd.qos, 0)
    assert.equal(armCmd.retain, false)
    const armPayload = decodePayload(armCmd.payload)
    assert.equal(armPayload.seq, undefined, 'no seq on a DCMD')
    assert.ok(typeof armPayload.timestamp === 'number')
    assert.deepEqual(armPayload.metrics.map((x) => [x.alias, metricValue(x)]), [[robot.aliasOf.get(JOINT_METRICS.arm), 'mq-1']])
    data(dataMetrics(robot, frame(5, [0.11, 0.25, 0.3]), { armed: 'mq-1', beat: 1 }))
    assert.deepEqual(await p.next('armed'), { t: 'armed', id: 'g1/n1/arm', nonce: 'mq-1' })
    assert.deepEqual(await p.next('beat'), { t: 'beat', id: 'g1/n1/arm', n: 1 })
    // Setpoints: a DCMD with the gate's words and the positions, by alias, no seq in the payload; the device reads it back and acks.
    const want = setpoints(1, [0.5, -0.1, 0.9])
    p.send({ t: 'targets', id: 'g1/n1/arm', setpoints: want })
    const cmd = await edge.next((x) => x.topic === topic('g1', 'DCMD', 'n1', 'arm'), edge.got.indexOf(armCmd) + 1)
    const cmdPayload = decodePayload(cmd.payload)
    assert.equal(cmdPayload.seq, undefined)
    assert.ok(cmdPayload.metrics.every((x) => x.name === undefined && x.alias !== undefined), 'by alias alone')
    const readBack = targetsFromCommand(robot, cmdPayload)
    assert.ok(readBack.ok)
    assert.deepEqual([readBack.value.seq, readBack.value.q, readBack.value.ttlMs], [1, [0.5, -0.1, 0.9], 200])
    data(dataMetrics(robot, frame(6, [0.2, 0, 0.5]), { ack: 1 }))
    assert.deepEqual(await p.next('ack'), { t: 'ack', id: 'g1/n1/arm', seq: 1 })
    // The device born without aliases is commanded by name.
    p.send({ t: 'arm', id: 'g1/n1/named', nonce: 'mq-2' })
    const named = await edge.next((x) => x.topic === topic('g1', 'DCMD', 'n1', 'named'))
    assert.deepEqual(decodePayload(named.payload).metrics.map((x) => [x.name, x.alias, metricValue(x)]), [[JOINT_METRICS.arm, undefined, 'mq-2']])
    // A gap in the node's seq: one Rebirth (NCMD), and not another within the debounce.
    const rebirthsBefore = edge.got.filter((x) => x.topic === topic('g1', 'NCMD', 'n1')).length
    seq += 7
    data([{ alias: 5, value: { kind: 'double', value: 0.26 } }])
    const ncmd = await edge.next((x) => x.topic === topic('g1', 'NCMD', 'n1'), rebirthsBefore)
    const ncmdPayload = decodePayload(ncmd.payload)
    assert.deepEqual(ncmdPayload.metrics.map((x) => [x.name, metricValue(x)]), [[SPARKPLUG.rebirth, true]])
    assert.equal(ncmd.qos, 0)
    seq += 7
    data([{ alias: 5, value: { kind: 'double', value: 0.27 } }])
    data([{ alias: 99, value: { kind: 'double', value: 1 } }], ++seq)
    await until(() => r.stats().frames >= 6, 'the gapped data still read')
    await sleep(40)
    assert.equal(edge.got.filter((x) => x.topic === topic('g1', 'NCMD', 'n1')).length, rebirthsBefore + 1, 'one Rebirth within the debounce')
    assert.equal(r.stats().mqtt?.rebirths, 1)
    // NDEATH with another bdSeq is ignored; with the birth's bdSeq it takes every device of the node offline and disarmed (no DCMD to a node that is gone).
    const cmdsBefore = edge.got.filter((x) => x.topic.includes('/DCMD/')).length
    edge.publish(topic('g1', 'NDEATH', 'n1'), bytes({ timestamp: Date.now(), metrics: [metric(SPARKPLUG.bdSeq, 'Int64', 5, 1)] }))
    await until(() => (r.stats().mqtt?.ignored ?? 0) === 2, 'the stranger NDEATH ignored')
    assert.equal(r.robots().length, 2)
    edge.publish(topic('g1', 'NDEATH', 'n1'), bytes({ timestamp: Date.now(), metrics: [metric(SPARKPLUG.bdSeq, 'Int64', 0, 1)] }))
    await p.next('robot', 0, (x) => x.id === 'g1/n1/arm' && x.gone === true)
    await p.next('robot', 0, (x) => x.id === 'g1/n1/named' && x.gone === true)
    assert.deepEqual((await p.next('disarm', 0, (x) => x.id === 'g1/n1/arm')).cause, 'NDEATH')
    assert.equal(r.robots().length, 0)
    assert.equal(r.stats().disarmed, 2)
    await sleep(30)
    assert.equal(edge.got.filter((x) => x.topic.includes('/DCMD/')).length, cmdsBefore, 'nothing was sent to the node that is gone')
    // Born again, then the broker drops the relay: the Will fires, the robots go, and a whole new session follows.
    edge.publish(topic('g1', 'NBIRTH', 'n1'), bytes({ timestamp: t0, metrics: [metric(SPARKPLUG.bdSeq, 'Int64', 1, t0)], seq: 0 }))
    edge.publish(topic('g1', 'DBIRTH', 'n1', 'arm'), bytes({ timestamp: t0, metrics: birth, seq: 1 }))
    await until(() => r.robots().length === 1, 'the robot back')
    const connectsBefore = packets().filter((x) => x.type === 'connect').length
    const dropFrom = edge.got.length
    broker.drop(CLIENT)
    const will = await edge.next((x) => x.topic === STATE && parseState(x.payload)?.online === false, dropFrom)
    assert.deepEqual(parseState(will.payload), { online: false, timestamp: T1 }, 'the Will the broker holds is this session\'s')
    await p.next('robot', 0, (x) => x.id === 'g1/n1/arm' && x.gone === true)
    await until(() => packets().filter((x) => x.type === 'connect').length === connectsBefore + 1 && r.stats().mqtt?.online === true, 'a new session')
    assert.equal(r.stats().mqtt?.sessions, 2)
    const again = packets().filter((x) => x.type === 'connect').at(-1) as Extract<Packet, { type: 'connect' }>
    assert.ok(again.cleanSession && again.clientId === CLIENT)
    const T2 = parseState(again.will!.payload)!.timestamp
    assert.ok(T2 >= T1)
    const online2 = await edge.next((x) => x.topic === STATE && parseState(x.payload)?.online === true, edge.got.indexOf(will) + 1)
    assert.equal(parseState(online2.payload)!.timestamp, T2, 'the new online certificate carries the new T')
    assert.ok(log.some((l) => /session dropped: the broker closed the connection; reconnecting in 20 ms/.test(l)))
    // A graceful close: offline with this session's T, then DISCONNECT, so the Will does not fire.
    await r.close()
    const tail = packets().slice(-2)
    assert.ok(tail[0].type === 'publish' && tail[0].topic === STATE && tail[0].retain)
    assert.deepEqual(parseState((tail[0] as Publish).payload), { online: false, timestamp: T2 })
    assert.equal(tail[1].type, 'disconnect')
    await until(() => !broker.clients.has(CLIENT), 'the relay gone from the broker')
    assert.equal(utf8.decode(broker.retained.get(STATE)!.payload), JSON.stringify({ online: false, timestamp: T2 }))
  } finally {
    edge.close()
    await r.close()
    await broker.close()
  }
})

test('Sparkplug B sessions that fail: a SUBACK of 0x80 closes the session (and it is tried again), and a missed PINGRESP closes it', async () => {
  const refusing = await startBroker({ refuse: [`${SPARKPLUG.namespace}/#`] })
  const lines: string[] = []
  const r1 = await relay({ log: (l) => lines.push(l), mqtt: { url: `mqtt://127.0.0.1:${refusing.port}`, clientId: 'agentcity-00000001', backoff: { minMs: 20, maxMs: 40 } } })
  try {
    await until(() => refusing.log.filter((e) => e.packet.type === 'connect').length >= 2, 'a second session attempted after the refusal')
    assert.ok(lines.some((l) => /refused a subscription \(SUBACK 80,1\)/.test(l)), lines.join('\n'))
    assert.equal(r1.stats().mqtt?.online, false)
    assert.ok(!refusing.log.some((e) => e.packet.type === 'publish'), 'never online: no STATE published')
  } finally {
    await r1.close()
    await refusing.close()
  }
  const mute = await startBroker({ mutePing: true })
  const lines2: string[] = []
  const r2 = await relay({ log: (l) => lines2.push(l), mqtt: { url: `mqtt://127.0.0.1:${mute.port}`, clientId: 'agentcity-00000002', keepAliveS: 1, backoff: { minMs: 20, maxMs: 40 } } })
  try {
    await until(() => mute.log.filter((e) => e.packet.type === 'connect').length >= 2, 'reconnected after the missed PINGRESP')
    assert.ok(mute.log.some((e) => e.packet.type === 'pingreq'))
    assert.ok(lines2.some((l) => /session dropped: missed PINGRESP/.test(l)), lines2.join('\n'))
  } finally {
    await r2.close()
    await mute.close()
  }
})

test('a short secret starts no relay; tokens are minted for a day', async () => {
  await assert.rejects(startRelay({ secret: 'short' }), /at least 16 characters/)
  const r = await relay({ now: () => 1_000_000 })
  try {
    const t = r.token(SUBJECTS.page)
    assert.equal(t.split('.')[1], String(1_000_000 + 24 * 3600 * 1000))
  } finally {
    await r.close()
  }
})
