/**
 * Why does this file exist? It drives the page's network client (netClient.ts) against the real Node host
 * (replication.node.ts, here over the open-plane authority, plane.node.ts) on a loopback socket, with Node 22's own
 * WebSocket as the client's default socket: the address and token rules, the token offered on the upgrade, a join
 * welcomed with the spawn to snap to and its status walk, the realm's steps reported as moves (coalesced into runs
 * while the rate is spent, never sent from before a correction) and acknowledged by the room's snapshots, a lie
 * corrected and the client snapped and honest again, two clients seeing each other's poses move and carried forward
 * between snapshots, chat and pings relayed to the callbacks and screened before they leave, a leave that closes
 * cleanly and a host that closes every client, and a host whose messages the core refuses being left after
 * HOST_REFUSALS of them (through an injected socket). Every wait is for the event to be observed, never a fixed sleep.
 * What breaks if it is removed? The client's connect/reconcile flow could drift from the host's without a test going red.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RUN } from '../07_Execute_Actions/simProtocol.ts'
import { createNetClient, HOST_REFUSALS, netServer, type Move, type NetClient, type NetSocket, type NetStatus } from './netClient.ts'
import { netServer as gate } from '../02_Define_The_Rules/airgap.ts'
import { planeAuthority, planeStep } from './plane.node.ts'
import { AUTH_PREFIX, encode, LIMITS, PROTOCOL_VERSION, sealMessage, SUBPROTOCOL, type ChatRelayMessage, type PingRelayMessage, type RemotePlayer, type SnapshotMessage } from './replication.ts'
import { startHost, type Host } from './replication.node.ts'

const SECRET = 'client-test-secret'
const WORLD = 'plane'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Polls until `cond` holds, at most 3 s. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let t = 0; t < 3000; t += 10) {
    if (cond()) return
    await sleep(10)
  }
  assert.ok(cond(), `still waiting: ${what}`)
}

async function withHost(fn: (host: Host) => Promise<void>): Promise<void> {
  const host = await startHost({ secret: SECRET, tickHz: 50, authority: planeAuthority(WORLD) })
  try {
    await fn(host)
  } finally {
    await host.close()
  }
}

/**
 * An honest page on the plane: its realm walks where the plane would (planeStep), put down at each correction as the
 * engine puts player 1 down; `step` reports one realm step of `n` substeps at (vx, vz).
 */
function page(c: NetClient) {
  let at = { x: 0, y: 0, z: 0 }
  let fix = 0
  const snap = (): void => {
    const t = c.correction()
    if (t && t.fix > fix) {
      fix = t.fix
      at = { x: t.x, y: t.y, z: t.z }
    }
  }
  return {
    get at() { return at },
    get fix() { return fix },
    snap,
    step(vx: number, vz: number, n = 1, lie = 0): boolean {
      snap()
      at = planeStep(at, [[vx, vz, n]])
      const m: Move = { mode: 'foot', x: vx, z: vz, n, heading: 0, at: { ...at, z: at.z + lie }, fix }
      return c.move(m)
    },
  }
}

test('netServer: ws or wss to this machine only, never with credentials; the gate of airgap.ts under this name', () => {
  assert.equal(netServer('wss://localhost:8788/city'), 'wss://localhost:8788/city')
  assert.equal(netServer('ws://127.0.0.1:8787'), 'ws://127.0.0.1:8787/')
  assert.equal(netServer(' ws://localhost:8787 '), 'ws://localhost:8787/')
  assert.equal(netServer('ws://[::1]:8787'), 'ws://[::1]:8787/')
  assert.equal(netServer('wss://rooms.example.net/city'), null, 'a room off this machine, even over TLS')
  assert.equal(netServer('ws://rooms.example.net'), null, 'a token would cross the network in clear')
  assert.equal(netServer('wss://ada:secret@localhost:8788'), null)
  assert.equal(netServer('http://localhost:8787'), null)
  assert.equal(netServer, gate, 'one definition of this machine')
  assert.equal(netServer('not a url'), null)
  assert.equal(netServer(42), null)
})

test('connect refuses what it must before any socket opens: the address, the token, the name, the world, a second session; the token rides the upgrade', async () => {
  let opened = 0
  let offered: string[] = []
  const c = createNetClient({ open: (_url, protocols) => { opened++; offered = protocols; return { send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null } } })
  assert.match(c.connect('ws://rooms.example.net', 't', 'Ada', WORLD) ?? '', /only ws or wss to this machine/)
  assert.match(c.connect('wss://rooms.example.net', 't', 'Ada', WORLD) ?? '', /only ws or wss to this machine/)
  assert.match(c.connect('wss://localhost:8788', '', 'Ada', WORLD) ?? '', /token/)
  assert.match(c.connect('wss://localhost:8788', 'x'.repeat(LIMITS.token + 1), 'Ada', WORLD) ?? '', /token/)
  assert.match(c.connect('wss://localhost:8788', 'a token, with spaces', 'Ada', WORLD) ?? '', /cannot be offered/)
  assert.match(c.connect('wss://localhost:8788', 't', '   ', WORLD) ?? '', /name/)
  assert.match(c.connect('wss://localhost:8788', 't', 'Ada', '') ?? '', /world/)
  assert.equal(opened, 0, 'nothing opened for a refused connect')
  assert.equal(c.status, 'idle')
  assert.equal(c.connect('wss://localhost:8788', 'abc.123.x_y-z', 'Ada', WORLD), null)
  assert.equal(opened, 1)
  assert.deepEqual(offered, [SUBPROTOCOL, `${AUTH_PREFIX}abc.123.x_y-z`])
  assert.equal(c.status, 'connecting')
  assert.equal(c.connect('wss://localhost:8788', 't', 'Ada', WORLD), 'a session is already open')
  assert.equal(c.move({ mode: 'foot', x: 1, z: 0, n: 1, heading: 0, at: { x: 0, y: 0, z: 0 }, fix: 1 }), false, 'nothing is sent before the welcome')
  assert.equal(c.correction(), null)
  assert.equal(c.sendChat('hello'), false)
  assert.equal(c.sendPing('go', 0, 0, 0), false)
  c.leave()
  assert.equal(c.status, 'closed')
})

test('join over Node\'s WebSocket: the status walk, the welcome\'s spawn to snap to, the realm\'s steps acknowledged by the room\'s snapshots', async () => {
  await withHost(async (host) => {
    const statuses: NetStatus[] = []
    const a = createNetClient({ onStatus: (s) => statuses.push(s) })
    assert.equal(a.connect(host.url, host.token('ada'), 'Ada', WORLD), null)
    await until(() => a.status === 'joined', 'the welcome')
    assert.deepEqual(statuses, ['connecting', 'joining', 'joined'])
    assert.ok(a.id > 0, 'an id from the room')
    assert.equal(a.reason, null)
    assert.equal(a.replica.self, a.id)
    assert.deepEqual(a.poses(), [], 'alone in the room')
    assert.equal(host.room.peers.get(a.id)?.name, 'Ada')
    // The welcome is the first correction: the spawn, which the page snaps to before anything it ran counts.
    const spawn = a.correction()
    assert.deepEqual([spawn?.fix, spawn?.reason], [1, 'welcome'])
    assert.equal(a.corrections, 0, 'the spawn is not counted as a correction')
    const p = page(a)
    assert.equal(a.move({ mode: 'foot', x: 1, z: 0, n: 1, heading: 0, at: { x: 9, y: 0, z: 9 }, fix: 0 }), false, 'a step from before the snap is never sent')
    assert.equal(a.pending().length, 0)
    // One step: pending until a snapshot carries an ack at or past its seq; the room kept it.
    assert.equal(p.step(1, 0, 3), true)
    assert.equal(a.pending().length, 1)
    assert.equal(a.pending()[0].seq, 1)
    await until(() => a.pending().length === 0, 'the ack')
    const peer = host.room.peers.get(a.id)!
    assert.deepEqual([peer.seq, peer.x, peer.z], [1, p.at.x, p.at.z])
    await until(() => a.replica.you?.x === p.at.x, 'the snapshot carries the truth')
    // Not finite, or no substep: nothing to send.
    assert.equal(a.move({ mode: 'foot', x: Number.NaN, z: 0, n: 1, heading: 0, at: p.at, fix: 1 }), false)
    assert.equal(a.move({ mode: 'foot', x: 1, z: 0, n: 0, heading: 0, at: p.at, fix: 1 }), false)
    // A realm paced like a page (a substep a sixtieth of a second): every step kept, none corrected.
    for (let i = 0; i < 20; i++) {
      p.step(i % 2 ? 2 : 1, 0)
      await sleep(1000 / 60)
    }
    await until(() => host.room.peers.get(a.id)?.x === p.at.x, 'every step the room replayed')
    assert.equal(a.corrections, 0, 'all of it honest')
    a.leave()
    assert.equal(a.status, 'closed')
    assert.equal(a.reason, 'left')
    await until(() => host.connections() === 0, 'the host saw the leave')
  })
})

test('a lie is corrected: the client snaps to the truth, steps from before the snap are dropped, and it is honest again', async () => {
  await withHost(async (host) => {
    const a = createNetClient()
    assert.equal(a.connect(host.url, host.token('ada'), 'Ada', WORLD), null)
    await until(() => a.status === 'joined', 'the welcome')
    const p = page(a)
    for (let i = 0; i < 5; i++) assert.equal(p.step(0, RUN, 2), true)
    await until(() => host.room.peers.get(a.id)?.seq === 5, 'the honest steps kept')
    const truth = { ...p.at }
    // The page claims 40 m along: the room refuses it and answers with the truth under correction 2.
    p.step(0, RUN, 2, 40)
    await until(() => a.correction()?.fix === 2, 'the correction')
    const c = a.correction()!
    assert.deepEqual([c.x, c.z], [truth.x, truth.z], 'the truth is where the honest steps left it')
    assert.match(c.reason, /claim 40\.\d\d m from the plane's pose/)
    assert.deepEqual([a.corrections, a.corrected], [1, c.reason])
    // A step the realm ran before it was put down there is never sent.
    assert.equal(a.move({ mode: 'foot', x: 0, z: RUN, n: 1, heading: 0, at: { x: 0, y: 0, z: 99 }, fix: 1 }), false)
    // Snapped (the engine's teleport), the page is honest again under correction 2.
    p.snap()
    assert.equal(p.fix, 2)
    for (let i = 0; i < 3; i++) assert.equal(p.step(0, RUN, 2), true)
    await until(() => host.room.peers.get(a.id)?.z === p.at.z, 'kept again')
    assert.equal(a.corrections, 1)
    a.leave()
  })
})

test('two clients: each sees the other\'s pose move as the room keeps its steps, carried forward between snapshots', async () => {
  await withHost(async (host) => {
    const a = createNetClient(), b = createNetClient()
    assert.equal(a.connect(host.url, host.token('ada'), 'Ada', WORLD), null)
    await until(() => a.status === 'joined', 'Ada joins')
    assert.equal(b.connect(host.url, host.token('bob'), 'Bob', WORLD), null)
    await until(() => b.status === 'joined', 'Bob joins')
    assert.notEqual(a.id, b.id)
    await until(() => b.poses().some((p) => p.id === a.id), 'Bob sees Ada')
    await until(() => a.poses().some((p) => p.id === b.id), 'Ada sees Bob')
    assert.equal(a.poses().find((p) => p.id === b.id)?.name, 'Bob')
    assert.ok(!b.poses().some((p) => p.id === b.id), 'never oneself')
    // Ada runs diagonally (each component within the validator's ±RUN); the room caps the pace at RUN; Bob's replica
    // carries her forward.
    const pa = page(a)
    const x0 = b.poses().find((p) => p.id === a.id)!.x
    assert.equal(pa.step(RUN, RUN, 3), true)
    await until(() => (b.poses().find((p) => p.id === a.id)?.vx ?? 0) > 0, 'her velocity reaches Bob')
    const seen: RemotePlayer = b.poses().find((p) => p.id === a.id)!
    assert.ok(Math.abs(seen.vx - RUN / Math.SQRT2) < 2e-3, `capped at a run (${seen.vx})`)
    assert.ok(Math.abs(seen.speed - RUN) < 2e-3)
    assert.equal(seen.driving, false)
    await until(() => (b.poses().find((p) => p.id === a.id)?.x ?? x0) > x0 + 0.05, 'she moved')
    const now = Date.now()
    const here = b.poses(now).find((p) => p.id === a.id)!, later = b.poses(now + 100).find((p) => p.id === a.id)!
    assert.ok(later.x > here.x, 'predicted forward by her own velocity')
    assert.ok(later.x - here.x <= (RUN / Math.SQRT2) * LIMITS.predictS + 1e-2, 'and no further than the prediction bound')
    a.leave()
    await until(() => !b.poses().some((p) => p.id === a.id), 'Bob sees Ada gone')
    b.leave()
    await until(() => host.connections() === 0, 'both gone')
  })
})

test('chat and pings: relayed to the callbacks by the room, screened under 14A before they leave this client', async () => {
  await withHost(async (host) => {
    const chats: ChatRelayMessage[] = [], pings: PingRelayMessage[] = []
    const a = createNetClient({ onChat: (m) => chats.push(m), onPing: (m) => pings.push(m) })
    const b = createNetClient()
    assert.equal(a.connect(host.url, host.token('ada'), 'Ada', WORLD), null)
    assert.equal(b.connect(host.url, host.token('bob'), 'Bob', WORLD), null)
    await until(() => a.status === 'joined' && b.status === 'joined', 'both join')
    assert.equal(b.sendChat('  Could you bring the forms to the counter?  '), true)
    await until(() => chats.length === 1, 'the chat relay')
    assert.equal(chats[0].from, b.id)
    assert.equal(chats[0].name, 'Bob')
    assert.equal(chats[0].text, 'Could you bring the forms to the counter?')
    // Inadmissible: dropped here, counted by nobody, never on the wire.
    const refusals = host.room.peers.get(b.id)!.refusals
    assert.equal(b.sendChat('shut up, all of you'), false)
    assert.equal(b.sendChat(''), false)
    assert.equal(b.sendPing('go' as never, Number.NaN, 0, 0), false)
    assert.equal(b.sendPing('gather', 3, 0, -4), true)
    await until(() => pings.length === 1, 'the ping relay')
    assert.deepEqual([pings[0].from, pings[0].kind, pings[0].x, pings[0].y, pings[0].z], [b.id, 'gather', 3, 0, -4])
    await sleep(60)
    assert.equal(host.room.peers.get(b.id)!.refusals, refusals, 'the room counted nothing against Bob')
    assert.equal(chats.length, 1)
    a.leave()
    b.leave()
    await until(() => host.connections() === 0, 'both gone')
  })
})

test('the host closing ends every client with its reason; a token the host refuses never opens a session', async () => {
  const host = await startHost({ secret: SECRET, tickHz: 50, authority: planeAuthority(WORLD) })
  const a = createNetClient()
  assert.equal(a.connect(host.url, host.token('ada'), 'Ada', WORLD), null)
  await until(() => a.status === 'joined', 'Ada joins')
  const forged = createNetClient()
  assert.equal(forged.connect(host.url, 'forged.1.token', 'Eve', WORLD), null)
  await until(() => forged.status === 'closed', 'the upgrade refused')
  assert.equal(host.room.peers.size, 1, 'no slot for the forged token')
  await host.close()
  await until(() => a.status === 'closed', 'Ada sees the host go')
  assert.equal(a.reason, 'host closing')
  assert.deepEqual(a.poses(), [])
  assert.equal(a.move({ mode: 'foot', x: 0, z: 0, n: 1, heading: 0, at: { x: 0, y: 0, z: 0 }, fix: 1 }), false)
})

test('over the client\'s own rate the steps are held and coalesced into runs, the claim always where the last run ended; a mode change or a full input goes at once', () => {
  let clock = 0
  let socket: NetSocket | null = null
  const sent: { body: { t: string; seq: number; segs: number[][]; claim: { z: number }; mode: string; from?: unknown } }[] = []
  const c = createNetClient({
    now: () => clock,
    open: () => (socket = { send: (d) => { sent.push(JSON.parse(d)) }, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
  })
  assert.equal(c.connect('wss://localhost:8788', 'token', 'Ada', WORLD), null)
  const s = socket as unknown as NetSocket
  s.onopen?.({})
  const you = { id: 1, name: 'Ada', x: 0, y: 0.92, z: 0, heading: 0, vx: 0, vz: 0, speed: 0, driving: false }
  s.onmessage?.({ data: sealMessage({ t: 'welcome', v: PROTOCOL_VERSION, id: 1, tick: 0, tickHz: 20, fix: 1, you, players: [] }, 1, 'token') })
  const step = (z: number, vz: number, n = 1, mode: 'foot' | 'drive' = 'foot', from?: { x: number; z: number }): boolean =>
    c.move({ mode, x: 0, z: vz, n, heading: 0, at: { x: 0, y: 0.92, z }, fix: 1, ...(from && { from }) })
  for (let i = 1; i <= LIMITS.inputBurst; i++) assert.equal(step(i, 1), true, `step ${i} within the burst`)
  const inputs = () => sent.filter((m) => m.body.t === 'input').map((m) => m.body)
  assert.equal(inputs().length, LIMITS.inputBurst)
  // The rate is spent: three steps at one velocity, two at another, held as two runs.
  assert.equal(step(121, 1), false)
  assert.equal(step(122, 1), false)
  assert.equal(step(123, 1, 2), false)
  assert.equal(step(124, 2), false)
  assert.equal(step(125, 2), false)
  assert.equal(inputs().length, LIMITS.inputBurst, 'nothing more on the wire')
  // A sixtieth of a second later there is a token: one input, both runs, the claim where the last one ended.
  clock = 1000 / 60
  assert.equal(step(126, 2), true)
  const last = inputs().at(-1)!
  assert.deepEqual(last.segs, [[0, 1, 4], [0, 2, 3]])
  assert.equal(last.claim.z, 126)
  // A mode change sends what is held first, whatever the rate says: a run is never claimed at another mode's pose.
  assert.equal(step(127, 3), false)
  const before = inputs().length
  step(130, 0, 1, 'drive')
  assert.equal(inputs().length, before + 1, 'the held foot run went at once')
  assert.deepEqual([inputs().at(-1)!.mode, inputs().at(-1)!.segs, inputs().at(-1)!.claim.z], ['foot', [[0, 3, 1]], 127])
  // At the wheel the held run and the next merge; leaving the car starts an input of its own, the exit point first.
  clock += 1000
  step(131, 0, 4, 'drive')
  step(132, 1, 1, 'foot', { x: 1, z: 131 })
  const [drove, walked] = inputs().slice(-2)
  assert.deepEqual([drove.mode, drove.segs, drove.claim.z], ['drive', [[0, 0, 5]], 131])
  assert.deepEqual([walked.mode, walked.from, walked.segs], ['foot', { x: 1, z: 131 }, [[0, 1, 1]]])
  // A full input (LIMITS.stepsPerInput substeps) goes at once.
  clock += 1000
  for (let i = 0; i < 40; i++) step(140 + i, 1, 1)
  assert.ok(inputs().every((m) => m.segs.reduce((a, r) => a + r[2], 0) <= LIMITS.stepsPerInput), 'never more substeps than an input may carry')
  assert.ok(inputs().some((m) => m.from !== undefined), 'the exit point rode the first input on foot')
})

test('a host the core refuses: HOST_REFUSALS malformed messages and the client leaves with the reason (an injected socket)', () => {
  let socket: NetSocket | null = null
  let closed: { code: number; reason: string } | null = null
  const sent: string[] = []
  const c = createNetClient({
    open: () => {
      socket = { send: (d) => { sent.push(d) }, close: (code = 0, reason = '') => { closed = { code, reason } }, onopen: null, onmessage: null, onclose: null, onerror: null }
      return socket
    },
  })
  assert.equal(c.connect('wss://localhost:8788', 'token', 'Ada', WORLD), null)
  const s = socket as unknown as NetSocket
  s.onopen?.({})
  assert.equal(c.status, 'joining')
  assert.equal(sent.length, 1)
  assert.match(sent[0], /"t":"join"/)
  assert.match(sent[0], /"world":"plane"/)
  // The join went out sealed under the token, as envelope 1; an unsealed welcome is not read at all.
  assert.match(sent[0], /^\{"n":1,"body":\{"t":"join".*"mac":"[0-9a-f]{64}"\}$/)
  const you = { id: 7, name: 'Ada', x: 1, y: 0.92, z: 2, heading: 0, vx: 0, vz: 0, speed: 0, driving: false }
  const welcome = { t: 'welcome' as const, v: PROTOCOL_VERSION, id: 7, tick: 3, tickHz: 20, fix: 1, you, players: [] }
  s.onmessage?.({ data: encode(welcome) })
  assert.equal(c.status, 'joining', 'unsealed: dropped')
  s.onmessage?.({ data: sealMessage(welcome, 1, 'another token') })
  assert.equal(c.status, 'joining', 'sealed under another token: dropped')
  // A good welcome, then rubbish: the client tolerates HOST_REFUSALS − 1 refusals and leaves on the next.
  s.onmessage?.({ data: sealMessage(welcome, 1, 'token') })
  assert.equal(c.status, 'joined')
  assert.equal(c.id, 7)
  assert.deepEqual(c.correction(), { fix: 1, x: 1, y: 0.92, z: 2, reason: 'welcome' })
  // Two refusals so far. A sealed snapshot is applied once; the same frame again is a replay, and one under another key a forgery: neither moves the replica.
  const snapshot: SnapshotMessage = { t: 'snapshot', tick: 4, ack: 0, fix: 1, you, players: [] }
  const frame = sealMessage(snapshot, 2, 'token')
  s.onmessage?.({ data: frame })
  assert.equal(c.replica.tick, 4)
  s.onmessage?.({ data: frame })
  s.onmessage?.({ data: sealMessage({ ...snapshot, tick: 5 }, 3, 'another token') })
  s.onmessage?.({ data: sealMessage({ ...snapshot, tick: 5 }, 1, 'token') })
  assert.equal(c.replica.tick, 4, 'a replay, a forgery and a stale envelope number change nothing')
  // A correction no newer than the one held is ignored.
  s.onmessage?.({ data: sealMessage({ t: 'correct', fix: 1, ack: 0, you: { ...you, x: 50 }, reason: 'old', tick: 4 }, 4, 'token') })
  assert.equal(c.correction()?.x, 1)
  for (let i = 0; i < HOST_REFUSALS - 6; i++) s.onmessage?.({ data: '{"t":"snapshot","tick":"nope"}' })
  assert.equal(c.status, 'joined')
  s.onmessage?.({ data: 'not even JSON' })
  assert.equal(c.status, 'closed')
  assert.match(c.reason ?? '', /^host: /)
  assert.equal((closed as { code: number } | null)?.code, 1002)
  assert.equal(HOST_REFUSALS, LIMITS.refusalsBeforeKick)
})
