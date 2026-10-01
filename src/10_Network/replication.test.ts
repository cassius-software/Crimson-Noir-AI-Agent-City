/**
 * Why does this file exist? It proves the replication core (replication.ts): the validators refuse every crafted
 * message (shape, type, finite numbers, bounds, string lengths, unknown kinds) and hand back frozen copies with
 * nothing extra; the room is server-authoritative and deterministic (the same messages on the same clock give the
 * same snapshots), caps a walk at a run, keeps everyone within the world's range, refuses stale sequence numbers,
 * out-of-rate inputs, chat and pings, and removes a peer after repeated refusals; the 14A screen drops an inadmissible
 * chat line or name silently and counts it; the page's reconciliation ignores stale snapshots, drops the client's own
 * entry and never puts a remote player anywhere but a pose record.
 * What breaks if it is removed? A malformed or hostile message could reach the room, or a remote player could stop
 * being a pose.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RUN } from '../07_Execute_Actions/simProtocol.ts'
import {
  admissibleChat, admissibleName, admit, blend, bucket, createRoom, decodeClientMessage, decodeServerMessage, depart, emptyReplica, encode, expired,
  handle, LIMITS, packPoses, peerBuckets, pending, poses, predict, PROTOCOL_VERSION, readClientMessage, readServerMessage, reconcile, REMOTE_POSE,
  refuse, snapshotFor, take, tickRoom, type ClientMessage, type Peer, type RemotePlayer, type Room, type SnapshotMessage,
} from './replication.ts'

const ok = (u: unknown): ClientMessage => {
  const r = readClientMessage(u)
  assert.ok(r.ok, `expected ok: ${JSON.stringify(u)} → ${r.ok ? '' : r.reason}`)
  return r.msg
}
const refused = (u: unknown, why: RegExp): void => {
  const r = readClientMessage(u)
  assert.ok(!r.ok, `expected a refusal: ${JSON.stringify(u)}`)
  assert.match(r.reason, why)
}
const player = (id: number, over: Partial<RemotePlayer> = {}): RemotePlayer => ({ id, name: `p${id}`, x: 0, y: 0, z: 0, heading: 0, vx: 0, vz: 0, speed: 0, ...over })

// ---------------------------------------------------------------- validators

test('readClientMessage: the good shapes come back frozen, plain, and with nothing extra in them', () => {
  const join = ok({ t: 'join', v: PROTOCOL_VERSION, token: 'abc', name: 'Ada', extra: 1 })
  assert.deepEqual(join, { t: 'join', v: 1, token: 'abc', name: 'Ada' })
  assert.ok(Object.isFrozen(join))
  assert.deepEqual(ok({ t: 'input', seq: 1, ack: 0, x: 1, z: -1, heading: 0.5, pose: { x: 999 } }), { t: 'input', seq: 1, ack: 0, x: 1, z: -1, heading: 0.5 })
  assert.deepEqual(ok({ t: 'ack', ack: 7 }), { t: 'ack', ack: 7 })
  assert.deepEqual(ok({ t: 'chat', seq: 1, text: 'hello' }), { t: 'chat', seq: 1, text: 'hello' })
  assert.deepEqual(ok({ t: 'ping', seq: 2, kind: 'go', x: 1, y: 2, z: 3 }), { t: 'ping', seq: 2, kind: 'go', x: 1, y: 2, z: 3 })
  assert.deepEqual(ok({ t: 'leave', why: 'bye' }), { t: 'leave' })
})

test('readClientMessage: every crafted message is refused with the reason simHost would give', () => {
  for (const bad of [null, undefined, 1, 'join', [], [{ t: 'join' }], true]) refused(bad, /not a message object/)
  refused({}, /unknown message 'undefined'/)
  refused({ t: 'step' }, /unknown message 'step'/)
  refused({ t: 'join', v: 2, token: 'a', name: 'b' }, /protocol 2 is not 1/)
  refused({ t: 'join', v: '1', token: 'a', name: 'b' }, /protocol/)
  refused({ t: 'join', v: 1, name: 'b' }, /token/)
  refused({ t: 'join', v: 1, token: '', name: 'b' }, /token/)
  refused({ t: 'join', v: 1, token: 'x'.repeat(LIMITS.token + 1), name: 'b' }, /token/)
  refused({ t: 'join', v: 1, token: 'a', name: 'x'.repeat(LIMITS.name + 1) }, /name/)
  refused({ t: 'join', v: 1, token: 'a', name: 'line\nbreak' }, /name/)
  refused({ t: 'join', v: 1, token: 'a', name: 7 }, /name/)
  refused({ t: 'input', seq: -1, ack: 0, x: 0, z: 0, heading: 0 }, /seq and ack/)
  refused({ t: 'input', seq: 1.5, ack: 0, x: 0, z: 0, heading: 0 }, /seq and ack/)
  refused({ t: 'input', seq: '1', ack: 0, x: 0, z: 0, heading: 0 }, /seq and ack/)
  refused({ t: 'input', seq: LIMITS.maxSeq, ack: 0, x: 0, z: 0, heading: 0 }, /seq and ack/)
  refused({ t: 'input', seq: 1, ack: 0, x: NaN, z: 0, heading: 0 }, /velocity/)
  refused({ t: 'input', seq: 1, ack: 0, x: Infinity, z: 0, heading: 0 }, /velocity/)
  refused({ t: 'input', seq: 1, ack: 0, x: 0, z: RUN + 0.01, heading: 0 }, /velocity/)
  refused({ t: 'input', seq: 1, ack: 0, x: '1', z: 0, heading: 0 }, /velocity/)
  refused({ t: 'input', seq: 1, ack: 0, x: 0, z: 0, heading: 7 }, /heading/)
  refused({ t: 'input', seq: 1, ack: 0, x: 0, z: 0 }, /heading/)
  refused({ t: 'ack', ack: -1 }, /ack/)
  refused({ t: 'chat', seq: 1, text: '' }, /text/)
  refused({ t: 'chat', seq: 1, text: '   ' }, /text/)
  refused({ t: 'chat', seq: 1, text: 'x'.repeat(LIMITS.chat + 1) }, /text/)
  refused({ t: 'chat', seq: 1, text: 'tab\there' }, /text/)
  refused({ t: 'chat', seq: 1, text: ['a'] }, /text/)
  refused({ t: 'chat', text: 'a' }, /seq/)
  refused({ t: 'ping', seq: 1, kind: 'rush', x: 0, y: 0, z: 0 }, /kind/)
  refused({ t: 'ping', seq: 1, kind: 'go', x: LIMITS.range + 1, y: 0, z: 0 }, /position/)
  refused({ t: 'ping', seq: 1, kind: 'go', x: 0, y: -LIMITS.height - 1, z: 0 }, /position/)
  refused({ t: 'ping', seq: 1, kind: 'go', x: 0, y: 0, z: NaN }, /position/)
})

test('decode: a bounded JSON text frame; too long, not JSON and not text are refused before anything is read', () => {
  assert.ok(decodeClientMessage(encode({ t: 'leave' })).ok)
  assert.match((decodeClientMessage('{') as { reason: string }).reason, /not JSON/)
  assert.match((decodeClientMessage(`{"t":"chat","seq":1,"text":"${'x'.repeat(LIMITS.message)}"}`) as { reason: string }).reason, /longer than/)
  assert.match((decodeClientMessage(1 as unknown as string) as { reason: string }).reason, /not text/)
  assert.match((decodeClientMessage('"join"') as { reason: string }).reason, /not a message object/)
})

test('readServerMessage: the host is checked the same way; a player list with one bad pose refuses the whole snapshot', () => {
  const good = { t: 'snapshot', tick: 3, ack: 2, players: [player(2, { x: 1, vx: 1, speed: 1 })] }
  const r = readServerMessage(good)
  assert.ok(r.ok)
  assert.deepEqual(r.msg, good)
  assert.ok(Object.isFrozen(r.msg) && Object.isFrozen((r.msg as SnapshotMessage).players[0]))
  const bad = (u: unknown, why: RegExp): void => {
    const x = readServerMessage(u)
    assert.ok(!x.ok, JSON.stringify(u))
    assert.match(x.reason, why)
  }
  bad({ t: 'snapshot', tick: 3, ack: 2, players: [player(2, { x: NaN })] }, /players/)
  bad({ t: 'snapshot', tick: 3, ack: 2, players: [player(2, { speed: RUN + 1 })] }, /players/)
  bad({ t: 'snapshot', tick: 3, ack: 2, players: [player(2, { name: 'x'.repeat(LIMITS.name + 1) })] }, /players/)
  bad({ t: 'snapshot', tick: 3, ack: 2, players: [{ id: 1 }] }, /players/)
  bad({ t: 'snapshot', tick: 3, ack: 2, players: new Array(LIMITS.peers + 1).fill(player(1)) }, /players/)
  bad({ t: 'snapshot', tick: -1, ack: 2, players: [] }, /tick and ack/)
  bad({ t: 'welcome', v: 1, id: 1, tick: 0, tickHz: 0, players: [] }, /tickHz/)
  bad({ t: 'welcome', v: 0, id: 1, tick: 0, tickHz: 20, players: [] }, /protocol/)
  bad({ t: 'chat', from: 1, name: 'a', text: 'hi' }, /tick/)
  bad({ t: 'ping', from: 1, kind: 'wait', x: 0, y: 0, z: 0, tick: 'now' }, /from and tick/)
  bad({ t: 'joined', player: player(1, { heading: 10 }), tick: 1 }, /player/)
  bad({ t: 'left', id: 1, reason: 'bye\n', tick: 1 }, /reason/)
  bad({ t: 'state' }, /unknown message 'state'/)
  assert.ok(decodeServerMessage(encode({ t: 'left', id: 1, reason: 'idle', tick: 9 })).ok)
})

// ---------------------------------------------------------------- the 14A screen

test('the screen: an inadmissible name or chat line is null; an ordinary business-casual one survives, trimmed', () => {
  assert.equal(admissibleName('  Ada Lovelace '), 'Ada Lovelace')
  assert.equal(admissibleName('you idiot'), null)
  assert.equal(admissibleName('Go To Hell'), null)
  assert.equal(admissibleName(''), null)
  assert.equal(admissibleName('   '), null)
  assert.equal(admissibleName('x'.repeat(LIMITS.name + 1)), null)
  assert.equal(admissibleChat('Could you bring the forms to the counter?'), 'Could you bring the forms to the counter?')
  assert.equal(admissibleChat('shut up, all of you'), null)
  assert.equal(admissibleChat('let us buy drugs'), null)
  assert.equal(admissibleChat('the skill list is ready'), 'the skill list is ready', 'skill is never read as kill')
  assert.equal(admissibleChat(undefined), null)
})

// ---------------------------------------------------------------- rate limits

test('token buckets: a burst, then the steady rate; the clock is the caller\'s and never runs backwards', () => {
  const b = bucket(3, 2, 1000)
  assert.deepEqual([take(b, 1000), take(b, 1000), take(b, 1000), take(b, 1000)], [true, true, true, false])
  assert.equal(take(b, 1499), false, 'half a token is not one')
  assert.equal(take(b, 1500), true, 'one token at 2 per second')
  assert.equal(take(b, 1200), false, 'going backwards refills nothing')
  assert.equal(take(b, 5000), true)
  assert.equal(b.tokens, 2, 'the burst is the cap')
  const p = peerBuckets(0)
  assert.equal(p.input.capacity, LIMITS.inputBurst)
  assert.equal(p.input.perSecond, LIMITS.inputsPerSecond)
  assert.equal(p.chat.capacity, LIMITS.chatPerMinute)
  assert.equal(p.chat.perSecond * 60, LIMITS.chatPerMinute)
  assert.equal(p.ping.perSecond, LIMITS.pingsPerSecond)
})

// ---------------------------------------------------------------- the room

const GOOD = 'good-token'
const verify = (t: string): boolean => t === GOOD
const joined = (room: Room, name: string, now: number): Peer => {
  const peer = admit(room, now)
  assert.ok(peer)
  const out = handle(room, peer, { t: 'join', v: 1, token: GOOD, name }, now, verify)
  assert.equal(out.refused, undefined)
  return peer
}

test('join: a good token and an admissible name are welcomed and announced; a bad token, a second join or anything before a join is refused', () => {
  const room = createRoom(20)
  const a = admit(room, 0)!
  const out = handle(room, a, { t: 'input', seq: 1, ack: 0, x: 0, z: 0, heading: 0 }, 0, verify)
  assert.equal(out.refused, 'input before join')
  assert.equal(handle(room, a, { t: 'join', v: 1, token: 'wrong', name: 'Ada' }, 0, verify).refused, 'join: bad token')
  assert.equal(a.joined, false)
  const w = handle(room, a, { t: 'join', v: 1, token: GOOD, name: ' Ada ' }, 5, verify)
  assert.deepEqual(w.reply, { t: 'welcome', v: 1, id: 1, tick: 0, tickHz: 20, players: [] })
  assert.deepEqual(w.broadcast, { t: 'joined', player: player(1, { name: 'Ada' }), tick: 0 })
  assert.equal(a.name, 'Ada')
  assert.equal(handle(room, a, { t: 'join', v: 1, token: GOOD, name: 'Ada' }, 6, verify).refused, 'join: already joined')
  const b = joined(room, 'Bob', 7)
  assert.deepEqual(poses(room).map((p) => p.name), ['Ada', 'Bob'])
  assert.deepEqual(depart(room, b, 'left'), { t: 'left', id: 2, reason: 'left', tick: 0 })
  assert.equal(depart(room, admit(room, 8)!, 'join timeout'), null, 'an unjoined peer leaves without a word')
  assert.equal(room.peers.size, 1)
})

test('join: an inadmissible name is dropped silently and counted; the room stays full at LIMITS.peers', () => {
  const room = createRoom()
  const a = admit(room, 0)!
  const out = handle(room, a, { t: 'join', v: 1, token: GOOD, name: 'you idiot' }, 0, verify)
  assert.deepEqual(out, { refused: 'join: name' })
  assert.equal(a.joined, false)
  assert.equal(a.refusals, 1)
  for (let i = room.peers.size; i < LIMITS.peers; i++) assert.ok(admit(room, 0))
  assert.equal(admit(room, 0), null)
})

test('input: integrated on the fixed tick, capped at a run, held within the range; stale seq, a future ack and over-rate inputs are refused', () => {
  const room = createRoom(10)
  const a = joined(room, 'Ada', 0)
  assert.deepEqual(handle(room, a, { t: 'input', seq: 1, ack: 0, x: 30, z: 40, heading: 1 }, 0, verify), {})
  assert.ok(Math.abs(Math.hypot(a.vx, a.vz) - RUN) < 1e-9, 'capped at a run')
  tickRoom(room)
  assert.equal(room.tick, 1)
  const s = snapshotFor(room, a)
  assert.equal(s.ack, 1)
  assert.ok(Math.abs(s.players[0].x - RUN * 0.6 / 10) < 1e-9)
  assert.ok(Math.abs(s.players[0].speed - RUN) < 1e-9)
  assert.equal(s.players[0].heading, 1)
  assert.equal(handle(room, a, { t: 'input', seq: 1, ack: 1, x: 0, z: 0, heading: 0 }, 1, verify).refused, 'input: stale seq')
  assert.equal(handle(room, a, { t: 'input', seq: 2, ack: 5, x: 0, z: 0, heading: 0 }, 1, verify).refused, 'input: ack from the future')
  assert.deepEqual(handle(room, a, { t: 'ack', ack: 1 }, 1, verify), {})
  assert.equal(handle(room, a, { t: 'ack', ack: 2 }, 1, verify).refused, 'ack: from the future')
  a.x = LIMITS.range - 0.1
  handle(room, a, { t: 'input', seq: 2, ack: 1, x: RUN, z: 0, heading: 0 }, 2, verify)
  tickRoom(room)
  assert.equal(a.x, LIMITS.range, 'held at the edge')
  // Over rate: the burst, then a refusal at the same instant.
  const b = joined(room, 'Bob', 0)
  let seq = 0
  for (let i = 0; i < LIMITS.inputBurst; i++) assert.equal(handle(room, b, { t: 'input', seq: ++seq, ack: 0, x: 0, z: 0, heading: 0 }, 0, verify).refused, undefined)
  assert.equal(handle(room, b, { t: 'input', seq: ++seq, ack: 0, x: 0, z: 0, heading: 0 }, 0, verify).refused, 'input: over rate')
  assert.equal(handle(room, b, { t: 'input', seq: ++seq, ack: 0, x: 0, z: 0, heading: 0 }, 1000 / LIMITS.inputsPerSecond, verify).refused, undefined, 'one more a tick later')
})

test('chat and ping: relayed to the room with the sender\'s id and name; inadmissible chat is dropped silently; over rate and stale seq refused', () => {
  const room = createRoom()
  const a = joined(room, 'Ada', 0)
  assert.deepEqual(handle(room, a, { t: 'chat', seq: 1, text: ' Good morning ' }, 0, verify), { broadcast: { t: 'chat', from: 1, name: 'Ada', text: 'Good morning', tick: 0 } })
  assert.deepEqual(handle(room, a, { t: 'chat', seq: 2, text: 'shut up' }, 0, verify), { refused: 'chat: inadmissible' })
  assert.equal(handle(room, a, { t: 'chat', seq: 2, text: 'again' }, 0, verify).refused, 'chat: stale seq')
  assert.deepEqual(handle(room, a, { t: 'ping', seq: 3, kind: 'gather', x: 1, y: 2, z: 3 }, 0, verify), { broadcast: { t: 'ping', from: 1, kind: 'gather', x: 1, y: 2, z: 3, tick: 0 } })
  for (let i = 1; i < LIMITS.pingBurst; i++) assert.equal(handle(room, a, { t: 'ping', seq: 3 + i, kind: 'go', x: 0, y: 0, z: 0 }, 0, verify).refused, undefined)
  assert.equal(handle(room, a, { t: 'ping', seq: 100, kind: 'go', x: 0, y: 0, z: 0 }, 0, verify).refused, 'ping: over rate')
  assert.equal(handle(room, a, { t: 'ping', seq: 100, kind: 'go', x: 0, y: 0, z: 0 }, 1000 / LIMITS.pingsPerSecond, verify).refused, undefined)
  const b = joined(room, 'Bob', 0)
  for (let i = 1; i <= LIMITS.chatPerMinute; i++) assert.equal(handle(room, b, { t: 'chat', seq: i, text: `line ${i}` }, 0, verify).refused, undefined)
  assert.equal(handle(room, b, { t: 'chat', seq: 99, text: 'one too many' }, 0, verify).refused, 'chat: over rate')
  assert.equal(handle(room, b, { t: 'chat', seq: 99, text: 'a minute later' }, 60_000, verify).refused, undefined)
  assert.deepEqual(handle(room, b, { t: 'leave' }, 60_000, verify), { left: true })
})

test('repeated refusals remove a peer: the limit is reached by malformed frames and inadmissible chat alike', () => {
  const room = createRoom()
  const a = joined(room, 'Ada', 0)
  for (let i = 1; i < LIMITS.refusalsBeforeKick; i++) {
    const out = i % 2 ? refuse(a, 'not JSON') : handle(room, a, { t: 'chat', seq: i, text: 'you moron' }, 0, verify)
    assert.equal(out.kick, undefined, `refusal ${i}`)
  }
  const last = refuse(a, 'not JSON')
  assert.deepEqual(last, { refused: 'not JSON', kick: 'repeated refusals' })
  assert.equal(a.refusals, LIMITS.refusalsBeforeKick)
})

test('expired: a peer that never joined is dropped after the join timeout, a silent one after the idle timeout', () => {
  const room = createRoom()
  const a = admit(room, 0)!
  const b = joined(room, 'Bob', 0)
  assert.deepEqual(expired(room, LIMITS.joinTimeoutMs - 1), [])
  assert.deepEqual(expired(room, LIMITS.joinTimeoutMs).map((e) => [e.peer.id, e.reason]), [[a.id, 'join timeout']])
  handle(room, b, { t: 'ack', ack: 0 }, 10_000, verify)
  assert.deepEqual(expired(room, 10_000 + LIMITS.idleTimeoutMs).map((e) => [e.peer.id, e.reason]), [[a.id, 'join timeout'], [b.id, 'idle']])
})

test('deterministic: two rooms fed the same messages on the same clock give the same snapshots', () => {
  const run = (): SnapshotMessage[] => {
    const room = createRoom(30)
    const a = joined(room, 'Ada', 0)
    const b = joined(room, 'Bob', 1)
    const out: SnapshotMessage[] = []
    for (let i = 1; i <= 50; i++) {
      handle(room, a, { t: 'input', seq: i, ack: room.tick, x: Math.sin(i), z: Math.cos(i) * 3, heading: i / 50 }, i * 33, verify)
      if (i % 3 === 0) handle(room, b, { t: 'input', seq: i, ack: room.tick, x: 2, z: -2, heading: 0 }, i * 33, verify)
      tickRoom(room)
      out.push(snapshotFor(room, a))
    }
    return out
  }
  assert.deepEqual(run(), run())
})

// ---------------------------------------------------------------- the replica

test('reconcile: the host\'s word replaces every remote pose, the client\'s own entry is dropped, a stale snapshot is ignored, the result is frozen', () => {
  const r0 = emptyReplica(2)
  const s1: SnapshotMessage = { t: 'snapshot', tick: 5, ack: 3, players: [player(3, { x: 1 }), player(2, { x: 9 }), player(1, { x: 2 })] }
  const r1 = reconcile(r0, s1)
  assert.deepEqual(r1.players.map((p) => [p.id, p.x]), [[1, 2], [3, 1]], 'by rising id, self gone')
  assert.equal(r1.tick, 5)
  assert.equal(r1.ack, 3)
  assert.ok(Object.isFrozen(r1) && Object.isFrozen(r1.players))
  assert.equal(reconcile(r1, { t: 'snapshot', tick: 5, ack: 4, players: [] }), r1, 'a repeat is ignored')
  assert.equal(reconcile(r1, { t: 'snapshot', tick: 4, ack: 4, players: [] }), r1, 'an older one is ignored')
  const r2 = reconcile(r1, { t: 'snapshot', tick: 6, ack: 2, players: [player(1, { x: 3 })] })
  assert.deepEqual(r2.players.map((p) => [p.id, p.x]), [[1, 3]], 'player 3 is gone when the host no longer lists it')
  assert.equal(r2.ack, 3, 'ack never falls')
  assert.deepEqual(reconcile(r0, s1), r1, 'deterministic')
  const inputs = [1, 2, 3, 4].map((seq) => ({ t: 'input' as const, seq, ack: 0, x: 0, z: 0, heading: 0 }))
  assert.deepEqual(pending(inputs, 3).map((i) => i.seq), [4])
})

test('predict and blend: a remote pose moves by its own velocity for at most predictS, within the range; the heading turns the short way', () => {
  const p = player(1, { x: 10, vx: 2, vz: -1, speed: Math.hypot(2, 1), heading: 3 })
  assert.equal(predict(p, 0), p)
  assert.deepEqual(predict(p, 0.1), { ...p, x: 10.2, z: -0.1 })
  assert.deepEqual(predict(p, 5), predict(p, LIMITS.predictS))
  assert.deepEqual(predict(p, NaN), p)
  assert.equal(predict(player(1, { x: LIMITS.range, vx: RUN }), 0.2).x, LIMITS.range)
  const a = player(1, { heading: 3 })
  const b = player(1, { heading: -3, x: 10 })
  const m = blend(a, b, 0.5)
  assert.equal(m.x, 5)
  assert.ok(Math.abs(Math.abs(m.heading) - Math.PI) < 1e-9, `through π, not through 0: ${m.heading}`)
  assert.deepEqual(blend(a, b, 0), { ...a, id: b.id, name: b.name })
  assert.deepEqual(blend(a, b, 1), { ...b, heading: a.heading + (-3 - 3 + Math.PI * 2) })
  assert.deepEqual(blend(a, b, 2), blend(a, b, 1), 'alpha is clamped')
})

test('packPoses: REMOTE_POSE is the layout, as many as fit, plain floats only', () => {
  const out = new Float32Array(REMOTE_POSE.stride * 2 + 3)
  const n = packPoses([player(1, { x: 1, y: 2, z: 3, heading: 0.5, vx: 1, vz: -1, speed: 1.5 }), player(2, { x: 4 }), player(3, { x: 7 })], out)
  assert.equal(n, 2)
  assert.deepEqual([...out.subarray(0, REMOTE_POSE.stride)], [1, 2, 3, 0.5, 1, -1, 1.5])
  assert.equal(out[REMOTE_POSE.stride + REMOTE_POSE.x], 4)
  assert.equal(REMOTE_POSE.stride, 7)
})
