/**
 * Why does this file exist? It drives the page's network client (netClient.ts) against the real Node host
 * (replication.node.ts) over a loopback socket, with Node 22's own WebSocket as the client's default socket: the
 * address rule, a join welcomed and its status walk, inputs sent at the client's own rate and acknowledged by the
 * room's snapshots, two clients seeing each other's poses move and carried forward between snapshots, chat and pings
 * relayed to the callbacks and screened before they leave, a leave that closes cleanly and a host that closes every
 * client, and a host whose messages the core refuses being left after HOST_REFUSALS of them (through an injected
 * socket). Every wait is for the event to be observed, never a fixed sleep.
 * What breaks if it is removed? The client's connect/reconcile flow could drift from the host's without a test going red.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RUN } from '../07_Execute_Actions/simProtocol.ts'
import { createNetClient, HOST_REFUSALS, netServer, type NetSocket, type NetStatus } from './netClient.ts'
import { encode, LIMITS, type ChatRelayMessage, type PingRelayMessage } from './replication.ts'
import { startHost, type Host } from './replication.node.ts'

const SECRET = 'client-test-secret'
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
  const host = await startHost({ secret: SECRET, tickHz: 50 })
  try {
    await fn(host)
  } finally {
    await host.close()
  }
}

test('netServer: wss anywhere, plain ws only to this machine, never with credentials', () => {
  assert.equal(netServer('wss://rooms.example.net/city'), 'wss://rooms.example.net/city')
  assert.equal(netServer('ws://127.0.0.1:8787'), 'ws://127.0.0.1:8787/')
  assert.equal(netServer(' ws://localhost:8787 '), 'ws://localhost:8787/')
  assert.equal(netServer('ws://[::1]:8787'), 'ws://[::1]:8787/')
  assert.equal(netServer('ws://rooms.example.net'), null, 'a token would cross the network in clear')
  assert.equal(netServer('wss://ada:secret@rooms.example.net'), null)
  assert.equal(netServer('https://rooms.example.net'), null)
  assert.equal(netServer('not a url'), null)
  assert.equal(netServer(42), null)
})

test('connect refuses what it must before any socket opens: the address, the token, the name, a second session', async () => {
  let opened = 0
  const c = createNetClient({ open: () => { opened++; return { send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null } } })
  assert.match(c.connect('ws://rooms.example.net', 't', 'Ada') ?? '', /only wss/)
  assert.match(c.connect('wss://rooms.example.net', '', 'Ada') ?? '', /token/)
  assert.match(c.connect('wss://rooms.example.net', 'x'.repeat(LIMITS.token + 1), 'Ada') ?? '', /token/)
  assert.match(c.connect('wss://rooms.example.net', 't', '   ') ?? '', /name/)
  assert.equal(opened, 0, 'nothing opened for a refused connect')
  assert.equal(c.status, 'idle')
  assert.equal(c.connect('wss://rooms.example.net', 't', 'Ada'), null)
  assert.equal(opened, 1)
  assert.equal(c.status, 'connecting')
  assert.equal(c.connect('wss://rooms.example.net', 't', 'Ada'), 'a session is already open')
  assert.equal(c.sendInput(1, 0, 0), false, 'nothing is sent before the welcome')
  assert.equal(c.sendChat('hello'), false)
  assert.equal(c.sendPing('go', 0, 0, 0), false)
  c.leave()
  assert.equal(c.status, 'closed')
})

test('join over Node\'s WebSocket: the status walk, the welcome, inputs acknowledged by the room\'s snapshots', async () => {
  await withHost(async (host) => {
    const statuses: NetStatus[] = []
    const a = createNetClient({ onStatus: (s) => statuses.push(s) })
    assert.equal(a.connect(host.url, host.token('ada'), 'Ada'), null)
    await until(() => a.status === 'joined', 'the welcome')
    assert.deepEqual(statuses, ['connecting', 'joining', 'joined'])
    assert.ok(a.id > 0, 'an id from the room')
    assert.equal(a.reason, null)
    assert.equal(a.replica.self, a.id)
    assert.deepEqual(a.poses(), [], 'alone in the room: the local avatar is never taken from a snapshot')
    assert.equal(host.room.peers.get(a.id)?.name, 'Ada')
    // One input: pending until a snapshot carries an ack at or past its seq.
    assert.equal(a.sendInput(1, 0, 0.5), true)
    assert.equal(a.pending().length, 1)
    assert.equal(a.pending()[0].seq, 1)
    await until(() => a.pending().length === 0, 'the ack')
    assert.ok(a.replica.ack >= 1)
    assert.ok(a.replica.tick > 0)
    // The room applied it: the authoritative pose moves at the velocity asked.
    const peer = host.room.peers.get(a.id)!
    assert.equal(peer.vx, 1)
    assert.equal(peer.heading, 0.5)
    // Not finite, or over the client's own rate (LIMITS.inputBurst banked, then LIMITS.inputsPerSecond): refused here, never sent.
    assert.equal(a.sendInput(Number.NaN, 0, 0), false)
    let sent = 0
    for (let i = 0; i < LIMITS.inputBurst * 2; i++) if (a.sendInput(0, 0, 0)) sent++
    assert.ok(sent < LIMITS.inputBurst * 2 && sent >= LIMITS.inputBurst - 1, `the burst is banked, then the rate holds (${sent})`)
    a.leave()
    assert.equal(a.status, 'closed')
    assert.equal(a.reason, 'left')
    await until(() => host.connections() === 0, 'the host saw the leave')
  })
})

test('two clients: each sees the other\'s pose move as the room integrates its inputs, carried forward between snapshots', async () => {
  await withHost(async (host) => {
    const a = createNetClient(), b = createNetClient()
    assert.equal(a.connect(host.url, host.token('ada'), 'Ada'), null)
    await until(() => a.status === 'joined', 'Ada joins')
    assert.equal(b.connect(host.url, host.token('bob'), 'Bob'), null)
    await until(() => b.status === 'joined', 'Bob joins')
    assert.notEqual(a.id, b.id)
    await until(() => b.poses().some((p) => p.id === a.id), 'Bob sees Ada')
    await until(() => a.poses().some((p) => p.id === b.id), 'Ada sees Bob')
    assert.equal(a.poses().find((p) => p.id === b.id)?.name, 'Bob')
    assert.ok(!b.poses().some((p) => p.id === b.id), 'never oneself')
    // Ada runs diagonally (each component within the validator's ±RUN); the room caps the pace at RUN; Bob's replica
    // carries her forward.
    const x0 = b.poses().find((p) => p.id === a.id)!.x
    assert.equal(a.sendInput(RUN, RUN, 0), true)
    await until(() => (b.poses().find((p) => p.id === a.id)?.vx ?? 0) > 0, 'her velocity reaches Bob')
    const seen = b.poses().find((p) => p.id === a.id)!
    assert.ok(Math.abs(seen.vx - RUN / Math.SQRT2) < 1e-5, `capped at a run (${seen.vx})`)
    assert.ok(Math.abs(seen.speed - RUN) < 1e-5)
    await until(() => (b.poses().find((p) => p.id === a.id)?.x ?? x0) > x0 + 0.05, 'she moved')
    const now = Date.now()
    const here = b.poses(now).find((p) => p.id === a.id)!, later = b.poses(now + 100).find((p) => p.id === a.id)!
    assert.ok(later.x > here.x, 'predicted forward by her own velocity')
    assert.ok(later.x - here.x <= (RUN / Math.SQRT2) * LIMITS.predictS + 1e-6, 'and no further than the prediction bound')
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
    assert.equal(a.connect(host.url, host.token('ada'), 'Ada'), null)
    assert.equal(b.connect(host.url, host.token('bob'), 'Bob'), null)
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

test('the host closing ends every client with its reason; a client never joined reports the socket\'s end', async () => {
  const host = await startHost({ secret: SECRET, tickHz: 50 })
  const a = createNetClient()
  assert.equal(a.connect(host.url, host.token('ada'), 'Ada'), null)
  await until(() => a.status === 'joined', 'Ada joins')
  await host.close()
  await until(() => a.status === 'closed', 'Ada sees the host go')
  assert.equal(a.reason, 'host closing')
  assert.deepEqual(a.poses(), [])
  assert.equal(a.sendInput(0, 0, 0), false)
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
  assert.equal(c.connect('wss://rooms.example.net', 'token', 'Ada'), null)
  const s = socket as unknown as NetSocket
  s.onopen?.({})
  assert.equal(c.status, 'joining')
  assert.equal(sent.length, 1)
  assert.match(sent[0], /"t":"join"/)
  // A good welcome, then rubbish: the client tolerates HOST_REFUSALS − 1 refusals and leaves on the next.
  s.onmessage?.({ data: encode({ t: 'welcome', v: 1, id: 7, tick: 3, tickHz: 20, players: [] }) })
  assert.equal(c.status, 'joined')
  assert.equal(c.id, 7)
  for (let i = 0; i < HOST_REFUSALS - 1; i++) s.onmessage?.({ data: '{"t":"snapshot","tick":"nope"}' })
  assert.equal(c.status, 'joined')
  s.onmessage?.({ data: 'not even JSON' })
  assert.equal(c.status, 'closed')
  assert.match(c.reason ?? '', /^host: /)
  assert.equal((closed as { code: number } | null)?.code, 1002)
  assert.equal(HOST_REFUSALS, LIMITS.refusalsBeforeKick)
})
