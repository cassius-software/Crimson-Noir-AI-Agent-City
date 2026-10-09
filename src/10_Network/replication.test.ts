// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the replication core (replication.ts): the validators refuse every crafted
 * message (shape, type, finite numbers, bounds, string lengths, unknown kinds) and hand back frozen copies with
 * nothing extra; the room is server-authoritative and deterministic (the same messages on the same clock give the
 * same snapshots): every input goes to the authority (here the open plane, plane.node.ts), a claim it refuses changes
 * nothing and is answered at once with a correction, inputs from before the snap are dropped unread, a client cannot
 * run more substeps than time allows, and a peer that keeps earning corrections or refusals is removed; chat and pings
 * keep their rates; the 14A screen drops an inadmissible chat line or name silently and counts it; the page's
 * reconciliation ignores stale snapshots, keeps the client's truth apart and never puts a remote player anywhere but a
 * pose record. Every frame on the wire is sealed: numbered, and signed under the session token over its canonical
 * body; a forged, altered or replayed frame is refused on either side without moving anything.
 * What breaks if it is removed? A malformed or hostile message could reach the room, or a remote player could stop
 * being a pose.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonical, hmacSha256 } from '../02_Define_The_Rules/integrity.ts'
import { ENTER_RANGE, RUN, type CarBodyState } from '../07_Execute_Actions/simProtocol.ts'
import { EXIT_SIDE } from '../07_Execute_Actions/carRig.ts'
import { forAll } from '../02_Define_The_Rules/property.ts'
import { GARAGE } from './garage.node.ts'
import { RING0 } from '../02_Define_The_Rules/ring0.ts'
import { KERNEL } from '../02_Define_The_Rules/civic.ts'
import { CAR } from '../07_Execute_Actions/car.ts'
import { MAX_CARS } from '../03_Spawn_Agents/crowdSensor.ts'
import { PLANE, planeAuthority, planeStep } from './plane.node.ts'
import {
  admissibleChat, admissibleName, admit, AUTH_PREFIX, authProtocol, blend, bucket, createRoom, decodeClientMessage, decodeServerMessage, depart,
  emptyReplica, encode, expired, handle, LIMITS, openClientFrame, openServerFrame, packPoses, peerBuckets, pending, poses, predict,
  PROTOCOL_VERSION, readClientMessage, readServerMessage, reconcile, REMOTE_POSE, refuse, refuseInput, sealMessage, snapshotFor, SUBPROTOCOL,
  take, takeMany, tickRoom,
  type Authority, type ClientMessage, type FootRun, type InputMessage, type Peer, type RemotePlayer, type Room, type ServerMessage, type SnapshotMessage,
  type Truth,
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
const player = (id: number, over: Partial<RemotePlayer> = {}): RemotePlayer => ({ id, name: `p${id}`, x: 0, y: 0, z: 0, heading: 0, vx: 0, vz: 0, speed: 0, driving: false, ...over })
/** An input on foot: one run, a claim (where the client says it is), under correction `fix`. */
const input = (seq: number, claim: { x: number; y: number; z: number }, o: Partial<InputMessage> = {}): InputMessage =>
  ({ t: 'input', seq, ack: 0, fix: 1, mode: 'foot', segs: [[0, 0, 1]], heading: 0, claim, ...o })
const STAND = { x: 0, y: PLANE.standing, z: 0 }

// ---------------------------------------------------------------- validators

test('readClientMessage: the good shapes come back frozen, plain, and with nothing extra in them', () => {
  const join = ok({ t: 'join', v: PROTOCOL_VERSION, token: 'abc', name: 'Ada', world: 'city/1337', extra: 1 })
  assert.deepEqual(join, { t: 'join', v: PROTOCOL_VERSION, token: 'abc', name: 'Ada', world: 'city/1337' })
  assert.ok(Object.isFrozen(join))
  const foot = { t: 'input', seq: 1, ack: 0, fix: 1, mode: 'foot', segs: [[1, -1, 2], [0, 0, 1]], heading: 0.5, claim: { x: 1, y: 0.92, z: -1, w: 7 } }
  const read = ok({ ...foot, pose: { x: 999 } }) as InputMessage
  assert.deepEqual(read, { ...foot, claim: { x: 1, y: 0.92, z: -1 } })
  assert.ok(Object.isFrozen(read) && Object.isFrozen(read.segs) && Object.isFrozen(read.segs[0]) && Object.isFrozen(read.claim))
  assert.deepEqual(ok({ ...foot, door: { exit: { x: 3, z: 4, y: 9 } } }), { ...foot, claim: { x: 1, y: 0.92, z: -1 }, door: { exit: { x: 3, z: 4 } } })
  const drive = { t: 'input', seq: 2, ack: 0, fix: 1, mode: 'drive', segs: [[0.5, 0, -0.2, 0, 20], [-1, LIMITS.brake, LIMITS.steer, 1, 10]], heading: 0, claim: { x: 30, y: 0.7, z: 0 } }
  assert.deepEqual(ok(drive), drive)
  const state = { x: 1, y: 0.56, z: 2, qx: 0, qy: 0.6, qz: 0, qw: 0.8, vx: 3, vy: 0, vz: 4, wx: 0, wy: 0.1, wz: 0 }
  const into = ok({ ...drive, door: { enter: { car: 3, state: { ...state, extra: 1 } }, note: 'x' } }) as InputMessage
  assert.deepEqual(into, { ...drive, door: { enter: { car: 3, state } } })
  assert.ok(into.door && 'enter' in into.door && Object.isFrozen(into.door.enter.state))
  assert.deepEqual(ok({ t: 'ack', ack: 7 }), { t: 'ack', ack: 7 })
  assert.deepEqual(ok({ t: 'chat', seq: 1, text: 'hello' }), { t: 'chat', seq: 1, text: 'hello' })
  assert.deepEqual(ok({ t: 'ping', seq: 2, kind: 'go', x: 1, y: 2, z: 3 }), { t: 'ping', seq: 2, kind: 'go', x: 1, y: 2, z: 3 })
  assert.deepEqual(ok({ t: 'leave', why: 'bye' }), { t: 'leave' })
})

test('readClientMessage: every crafted message is refused with the reason simHost would give', () => {
  for (const bad of [null, undefined, 1, 'join', [], [{ t: 'join' }], true]) refused(bad, /not a message object/)
  refused({}, /unknown message undefined/)
  refused({ t: 'step' }, /unknown message "step"/)
  refused({ t: Object.create(null) }, /unknown message object/)
  refused({ t: 'join', v: PROTOCOL_VERSION + 1, token: 'a', name: 'b' }, new RegExp(`protocol ${PROTOCOL_VERSION + 1} is not ${PROTOCOL_VERSION}`))
  refused({ t: 'join', v: '1', token: 'a', name: 'b' }, /protocol/)
  refused({ t: 'join', v: PROTOCOL_VERSION, name: 'b' }, /token/)
  refused({ t: 'join', v: PROTOCOL_VERSION, token: '', name: 'b' }, /token/)
  refused({ t: 'join', v: PROTOCOL_VERSION, token: 'x'.repeat(LIMITS.token + 1), name: 'b' }, /token/)
  refused({ t: 'join', v: PROTOCOL_VERSION, token: 'a', name: 'x'.repeat(LIMITS.name + 1) }, /name/)
  refused({ t: 'join', v: PROTOCOL_VERSION, token: 'a', name: 'line\nbreak' }, /name/)
  refused({ t: 'join', v: PROTOCOL_VERSION, token: 'a', name: 7, world: 'w' }, /name/)
  refused({ t: 'join', v: PROTOCOL_VERSION, token: 'a', name: 'b' }, /world/)
  refused({ t: 'join', v: PROTOCOL_VERSION, token: 'a', name: 'b', world: '' }, /world/)
  const good = { t: 'input', seq: 1, ack: 0, fix: 1, mode: 'foot', segs: [[0, 0, 1]], heading: 0, claim: { x: 0, y: 0, z: 0 } }
  refused({ ...good, seq: -1 }, /seq, ack and fix/)
  refused({ ...good, seq: 1.5 }, /seq, ack and fix/)
  refused({ ...good, seq: '1' }, /seq, ack and fix/)
  refused({ ...good, seq: LIMITS.maxSeq }, /seq, ack and fix/)
  refused({ ...good, fix: undefined }, /seq, ack and fix/)
  refused({ ...good, mode: 'fly' }, /mode/)
  refused({ ...good, segs: [] }, /runs/)
  refused({ ...good, segs: new Array(LIMITS.runs + 1).fill([0, 0, 1]) }, /runs/)
  refused({ ...good, segs: [[0, 0]] }, /runs/)
  refused({ ...good, segs: { 0: [0, 0, 1] } }, /runs/)
  refused({ ...good, segs: [[NaN, 0, 1]] }, /velocity/)
  refused({ ...good, segs: [[Infinity, 0, 1]] }, /velocity/)
  refused({ ...good, segs: [[0, RUN + 0.01, 1]] }, /velocity/)
  refused({ ...good, segs: [['1', 0, 1]] }, /velocity/)
  refused({ ...good, mode: 'drive', segs: [[1, 0, 1]] }, /runs/)
  const wheel = { ...good, mode: 'drive', segs: [[0, 0, 0, 0, 1]] }
  ok(wheel)
  refused({ ...wheel, segs: [[0, 0, 1]] }, /runs/)
  refused({ ...good, segs: [[0, 0, 0, 0, 1]] }, /runs/)
  refused({ ...wheel, segs: [[1.01, 0, 0, 0, 1]] }, /wheel command/)
  refused({ ...wheel, segs: [[-1.01, 0, 0, 0, 1]] }, /wheel command/)
  refused({ ...wheel, segs: [[0, -0.01, 0, 0, 1]] }, /wheel command/)
  refused({ ...wheel, segs: [[0, LIMITS.brake + 0.01, 0, 0, 1]] }, /wheel command/)
  refused({ ...wheel, segs: [[0, 0, LIMITS.steer + 0.01, 0, 1]] }, /wheel command/)
  refused({ ...wheel, segs: [[NaN, 0, 0, 0, 1]] }, /wheel command/)
  refused({ ...wheel, segs: [[0, 0, 0, 0.5, 1]] }, /handbrake/)
  refused({ ...wheel, segs: [[0, 0, 0, true, 1]] }, /handbrake/)
  refused({ ...wheel, segs: [[0, 0, 0, 0, 1.5]] }, /substeps/)
  refused({ ...wheel, segs: [[0, 0, 0, 0, LIMITS.stepsPerInput], [0, 0, 0, 0, 1]] }, /substeps/)
  refused({ ...good, segs: [[0, 0, 1.5]] }, /substeps/)
  refused({ ...good, segs: [[0, 0, -1]] }, /substeps/)
  refused({ ...good, segs: [[0, 0, LIMITS.stepsPerInput + 1]] }, /substeps/)
  refused({ ...good, segs: [[0, 0, LIMITS.stepsPerInput], [0, 0, 1]] }, /substeps/)
  refused({ ...good, heading: 7 }, /heading/)
  refused({ ...good, heading: undefined }, /heading/)
  refused({ ...good, claim: undefined }, /claim/)
  refused({ ...good, claim: { x: 0, z: 0 } }, /claim/)
  refused({ ...good, claim: { x: LIMITS.range + 1, y: 0, z: 0 } }, /claim/)
  refused({ ...good, claim: { x: 0, y: NaN, z: 0 } }, /claim/)
  // Doors: one of enter or exit, well formed, and agreeing with the mode.
  const st = { x: 1, y: 0.56, z: 2, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
  ok({ ...wheel, door: { enter: { car: 0, state: st } } })
  ok({ ...good, door: { exit: { x: 0, z: 0 } } })
  refused({ ...good, door: { exit: { x: 0 } } }, /door/)
  refused({ ...good, door: { exit: { x: 0, z: 0 }, enter: { car: 0, state: st } } }, /door/)
  refused({ ...good, door: {} }, /door/)
  refused({ ...good, door: 'exit' }, /door/)
  refused({ ...wheel, door: { exit: { x: 0, z: 0 } } }, /door and mode/)
  refused({ ...good, door: { enter: { car: 0, state: st } } }, /door and mode/)
  refused({ ...wheel, door: { enter: { car: LIMITS.cars, state: st } } }, /door/)
  refused({ ...wheel, door: { enter: { car: -1, state: st } } }, /door/)
  refused({ ...wheel, door: { enter: { car: 0.5, state: st } } }, /door/)
  refused({ ...wheel, door: { enter: { car: 0, state: { ...st, qw: 2 } } } }, /door/)
  refused({ ...wheel, door: { enter: { car: 0, state: { ...st, x: NaN } } } }, /door/)
  refused({ ...wheel, door: { enter: { car: 0, state: { ...st, vx: LIMITS.driveSpeed + 1 } } } }, /door/)
  refused({ ...wheel, door: { enter: { car: 0, state: { ...st, wy: 13 } } } }, /door/)
  refused({ ...wheel, door: { enter: { car: 0, state: { ...st, wz: undefined } } } }, /door/)
  refused({ ...good, from: { x: 0, z: 0 }, door: 1 }, /door/)
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
  const good = { t: 'snapshot', tick: 3, ack: 2, fix: 1, you: player(1), players: [player(2, { x: 1, vx: 1, speed: 1 })] }
  const r = readServerMessage(good)
  assert.ok(r.ok)
  assert.deepEqual(r.msg, good)
  assert.ok(Object.isFrozen(r.msg) && Object.isFrozen((r.msg as SnapshotMessage).players[0]) && Object.isFrozen((r.msg as SnapshotMessage).you))
  // A car may run to the velocity cap; a walker only to a run.
  const car = player(3, { vx: 30, speed: 30, driving: true })
  assert.ok(readServerMessage({ ...good, players: [car] }).ok)
  const correction = { t: 'correct', fix: 2, ack: 7, you: player(1, { x: 4 }), reason: 'claim 40.00 m from the mirror\'s pose', tick: 9 }
  assert.deepEqual((readServerMessage(correction) as { msg: unknown }).msg, correction)
  const bad = (u: unknown, why: RegExp): void => {
    const x = readServerMessage(u)
    assert.ok(!x.ok, JSON.stringify(u))
    assert.match(x.reason, why)
  }
  // At the wheel the correction carries the car, its chassis where `you` is; anything else about it refuses the message.
  const state = { x: 4, y: 0.56, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 1, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
  const wheel = { ...correction, you: player(1, { x: 4, y: 0.56, driving: true }), car: { index: 2, state } }
  const read = readServerMessage(wheel)
  assert.ok(read.ok && read.msg.t === 'correct' && read.msg.car?.index === 2 && Object.isFrozen(read.msg.car.state))
  bad({ ...wheel, you: player(1, { x: 4, y: 0.56 }) }, /correct: car/)
  bad({ ...wheel, car: { index: 2, state: { ...state, x: 5 } } }, /correct: car/)
  bad({ ...wheel, car: { index: LIMITS.cars, state } }, /correct: car/)
  bad({ ...wheel, car: { index: 2, state: { ...state, qw: 0.5 } } }, /correct: car/)
  // Whatever comes back is frozen all the way down, the lists of players included.
  const w = readServerMessage({ t: 'welcome', v: PROTOCOL_VERSION, id: 1, tick: 0, tickHz: 20, fix: 1, you: player(1), players: [player(2)] })
  assert.ok(w.ok && w.msg.t === 'welcome' && Object.isFrozen(w.msg.players))
  assert.ok(Object.isFrozen((readServerMessage(good) as { msg: SnapshotMessage }).msg.players))
  bad({ ...good, players: [player(2, { x: NaN })] }, /players/)
  bad({ ...good, players: [player(2, { speed: RUN + 1 })] }, /players/)
  bad({ ...good, players: [player(2, { vx: 30, speed: 30 })] }, /players/)
  bad({ ...good, players: [player(2, { speed: LIMITS.driveSpeed + 1, driving: true })] }, /players/)
  bad({ ...good, players: [{ ...player(2), driving: 'no' }] }, /players/)
  bad({ ...good, players: [player(2, { name: 'x'.repeat(LIMITS.name + 1) })] }, /players/)
  // 14A reads the host's player lists too: a name the room would refuse at join never reaches a caption or a voice label.
  bad({ ...good, players: [player(2, { name: 'you idiot' })] }, /players/)
  bad({ t: 'welcome', v: PROTOCOL_VERSION, id: 1, tick: 0, tickHz: 20, fix: 1, you: player(1), players: [player(2, { name: ' ' })] }, /players/)
  bad({ t: 'joined', tick: 1, player: player(2, { name: 'Kill Bill' }) }, /player/)
  bad({ ...good, players: [{ id: 1 }] }, /players/)
  bad({ ...good, players: new Array(LIMITS.peers + 1).fill(player(1)) }, /players/)
  bad({ ...good, tick: -1 }, /tick, ack and fix/)
  bad({ ...good, fix: undefined }, /tick, ack and fix/)
  bad({ ...good, you: player(1, { z: Infinity }) }, /you/)
  bad({ ...good, you: undefined }, /you/)
  bad({ t: 'welcome', v: PROTOCOL_VERSION, id: 1, tick: 0, tickHz: 0, fix: 1, you: player(1), players: [] }, /tickHz/)
  bad({ t: 'welcome', v: PROTOCOL_VERSION, id: 1, tick: 0, tickHz: 20, fix: 1, you: player(2), players: [] }, /you/)
  bad({ t: 'welcome', v: 0, id: 1, tick: 0, tickHz: 20, fix: 1, you: player(1), players: [] }, /protocol/)
  bad({ ...correction, you: player(1, { x: NaN }) }, /you/)
  bad({ ...correction, reason: 'two\nlines' }, /reason/)
  bad({ ...correction, fix: -1 }, /fix/)
  bad({ t: 'chat', from: 1, name: 'a', text: 'hi' }, /tick/)
  bad({ t: 'ping', from: 1, kind: 'wait', x: 0, y: 0, z: 0, tick: 'now' }, /from and tick/)
  bad({ t: 'joined', player: player(1, { heading: 10 }), tick: 1 }, /player/)
  bad({ t: 'left', id: 1, reason: 'bye\n', tick: 1 }, /reason/)
  bad({ t: 'state' }, /unknown message "state"/)
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

test('the screen reads a line as it renders: invisible characters and look-alike letters cannot hide a word, and nothing may reorder or break the line', () => {
  // Characters that draw nothing, inside a refused word: the line renders as the word, so it is refused.
  for (const hidden of ['\u200b', '\u00ad', '\u2060', '\u200d', '\ufeff', '\u180e', '\u034f', '\ufe0f']) {
    assert.equal(admissibleChat(`f${hidden}uck you`), null, `U+${hidden.codePointAt(0)!.toString(16)}`)
    assert.equal(admissibleName(`Ki${hidden}ller`), null, `U+${hidden.codePointAt(0)!.toString(16)} in a name`)
  }
  // Letters of other alphabets drawn like Latin ones (Cyrillic, Greek, Armenian, small capitals, fullwidth, mathematical).
  for (const line of ['kіll yourself', 'you mοron', 'ѕhut up', 'ᴋɪʟʟ', 'ｋｉｌｌ', '𝐤𝐢𝐥𝐥 yourself', 'іdіot', 'Κill']) assert.equal(admissibleChat(line), null, line)
  // A bidi override would render "kcuf" backwards as the word; a C1 control, DEL or a separator breaks the line: refused.
  for (const bad of ['\u202ekcuf', 'a\u2066b\u2069', 'hi\u0085there', 'x\u009b2K', 'x\u007f', 'a\u2028b', 'a\u2029b', 'a\ud800b']) {
    assert.equal(admissibleChat(bad), null, JSON.stringify(bad))
    assert.equal(admissibleName(bad.slice(0, LIMITS.name)), null, JSON.stringify(bad))
  }
  // Ordinary lines in other scripts, emoji sequences and accents still pass, as written.
  for (const fine of ['Привет, как дела?', 'Γειά σου κόσμε', 'שלום לכולם', 'こんにちは', '👩‍💻 ready at the desk', 'naïve café', 'Smith & Sons']) {
    assert.equal(admissibleChat(fine), fine, fine)
  }
  assert.equal(admissibleName('Zoë'), 'Zoë')
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
  const many = bucket(30, 60, 0)
  assert.equal(takeMany(many, 30, 0), true)
  assert.equal(takeMany(many, 1, 0), false)
  assert.equal(takeMany(many, 0, 0), true, 'no substeps cost nothing')
  assert.equal(takeMany(many, 30, 499), false, 'half a second refills 29.94')
  assert.equal(takeMany(many, 30, 500), true)
  const p = peerBuckets(0)
  assert.equal(p.input.capacity, LIMITS.inputBurst)
  assert.equal(p.input.perSecond, LIMITS.inputsPerSecond * LIMITS.headroom)
  assert.equal(peerBuckets(0, 1).input.perSecond, LIMITS.inputsPerSecond, 'the page paces itself at the realm\'s rate')
  assert.equal(p.steps.capacity, LIMITS.stepBurst)
  assert.equal(p.steps.perSecond, LIMITS.stepsPerSecond * LIMITS.headroom)
  assert.ok(LIMITS.headroom > 1 && LIMITS.headroom <= 1.05, 'a clock-speed cheat gains at most 5 %')
  assert.equal(p.corrections.capacity, LIMITS.correctionsPerMinute)
  assert.equal(p.corrections.perSecond * 60, LIMITS.correctionsPerMinute)
  assert.equal(p.chat.capacity, LIMITS.chatPerMinute)
  assert.equal(p.chat.perSecond * 60, LIMITS.chatPerMinute)
  assert.equal(p.ping.perSecond, LIMITS.pingsPerSecond)
  assert.equal(p.stale.capacity, LIMITS.inputBurst)
  assert.equal(p.doors.capacity, LIMITS.doorBurst)
  assert.equal(p.doors.perSecond, LIMITS.doorsPerSecond)
  // The substep budget is the realm's own fixed rate; a car's speed bound is the Ring-0 velocity cap; a run at the wheel
  // is bounded where the realm's bouncer bounds the command; a door names a car of the largest fleet the realm builds.
  assert.equal(LIMITS.stepsPerSecond, 1 / PLANE.h)
  assert.equal(LIMITS.driveSpeed, RING0.maxVelocity)
  assert.equal(LIMITS.brake, KERNEL.maxBrake)
  assert.equal(LIMITS.steer, CAR.maxSteer)
  assert.equal(LIMITS.throttle, 1)
  assert.equal(LIMITS.cars, MAX_CARS)
  // A stall the budgets ride out: three seconds of substeps and of inputs at the realm's rate.
  assert.ok(LIMITS.stepBurst >= 3 * LIMITS.stepsPerSecond && LIMITS.inputBurst >= 3 * LIMITS.inputsPerSecond)
})

test('the token rides the upgrade: auth.<token> for the characters a subprotocol may carry, nothing else', () => {
  assert.equal(SUBPROTOCOL, `onyx.${PROTOCOL_VERSION}`)
  assert.equal(authProtocol('b3BlcmF0b3I.1767225600000.aZ_-09'), `${AUTH_PREFIX}b3BlcmF0b3I.1767225600000.aZ_-09`)
  for (const bad of ['', 'a b', 'a,b', 'a=b', 'x'.repeat(LIMITS.token + 1), 7, null]) assert.equal(authProtocol(bad), null, String(bad))
})

// ---------------------------------------------------------------- the room

const GOOD = 'good-token'
const verify = (t: string): boolean => t === GOOD
const room0 = (tickHz?: number): Room => createRoom(planeAuthority(), tickHz)
const joined = (room: Room, name: string, now: number): Peer => {
  const peer = admit(room, now)
  assert.ok(peer)
  const out = handle(room, peer, { t: 'join', v: PROTOCOL_VERSION, token: GOOD, name, world: room.authority.world }, now, verify)
  assert.equal(out.refused, undefined)
  return peer
}
/** Where an honest client would claim to be after `runs`, from where the plane has peer `p` now. */
const honest = (p: Peer, runs: FootRun[]) => planeStep({ x: p.x, z: p.z }, runs)

test('join: a good token, the room\'s world and an admissible name are welcomed with the spawn and announced; anything else is refused', () => {
  const room = room0(20)
  const a = admit(room, 0)!
  const out = handle(room, a, input(1, STAND), 0, verify)
  assert.equal(out.refused, 'input before join')
  const join = { t: 'join' as const, v: PROTOCOL_VERSION, token: GOOD, name: ' Ada ', world: 'plane' }
  assert.equal(handle(room, a, { ...join, token: 'wrong' }, 0, verify).refused, 'join: bad token')
  assert.equal(handle(room, a, { ...join, world: 'city/1337' }, 0, verify).refused, 'join: world', 'a page walking another world')
  assert.equal(a.joined, false)
  const w = handle(room, a, join, 5, verify)
  const me = player(1, { name: 'Ada', y: PLANE.standing })
  assert.deepEqual(w.reply, { t: 'welcome', v: PROTOCOL_VERSION, id: 1, tick: 0, tickHz: 20, fix: 1, you: me, players: [] })
  assert.deepEqual(w.broadcast, { t: 'joined', player: me, tick: 0 })
  assert.equal(a.name, 'Ada')
  assert.equal(a.fix, 1, 'the welcome is the first correction: the client snaps to its spawn')
  assert.equal(handle(room, a, join, 6, verify).refused, 'join: already joined')
  const b = joined(room, 'Bob', 7)
  assert.deepEqual(poses(room).map((p) => [p.name, p.x]), [['Ada', 0], ['Bob', PLANE.spawnGap]])
  assert.deepEqual(depart(room, b, 'left'), { t: 'left', id: 2, reason: 'left', tick: 0 })
  assert.equal(room.authority.join(2).x, PLANE.spawnGap, 'its body left the authority')
  assert.equal(depart(room, admit(room, 8)!, 'join timeout'), null, 'an unjoined peer leaves without a word')
  assert.equal(room.peers.size, 1)
})

test('join: an inadmissible name is dropped silently and counted; the room stays full at LIMITS.peers', () => {
  const room = room0()
  const a = admit(room, 0)!
  const out = handle(room, a, { t: 'join', v: PROTOCOL_VERSION, token: GOOD, name: 'you idiot', world: 'plane' }, 0, verify)
  assert.deepEqual(out, { refused: 'join: name' })
  assert.equal(a.joined, false)
  assert.equal(a.refusals, 1)
  for (let i = room.peers.size; i < LIMITS.peers; i++) assert.ok(admit(room, 0))
  assert.equal(admit(room, 0), null)
})

test('input: an honest claim is kept; a claim off the truth is answered at once with a correction and changes nothing', () => {
  const room = room0(10)
  const a = joined(room, 'Ada', 0)
  // Half a second along the diagonal at a run on each axis (1.4 runs): the authority clamps it to a run, as the realm does.
  const runs: FootRun[] = [[RUN, RUN, 30]]
  const claim = honest(a, runs)
  assert.deepEqual(handle(room, a, input(1, claim, { segs: runs }), 0, verify), {})
  assert.deepEqual([a.x, a.z, a.seq], [claim.x, claim.z, 1])
  assert.ok(Math.abs(Math.hypot(a.vx, a.vz) - RUN) < 1e-9, 'a run, never faster')
  tickRoom(room)
  const s = snapshotFor(room, a)
  assert.deepEqual([s.ack, s.fix, s.you.x, s.you.z], [1, 1, a.x, a.z], 'the snapshot carries the truth, exact for the peer itself')
  // A lie: 40 m further than the walk. Refused and corrected at once; the truth stands.
  const at = { x: a.x, z: a.z }
  const lie = honest(a, [[0, RUN, 6]])
  const out = handle(room, a, input(2, { ...lie, z: lie.z + 40 }, { segs: [[0, RUN, 6]], ack: 1 }), 100, verify)
  assert.match(out.refused ?? '', /^claim 40\.\d\d m from the plane's pose$/)
  assert.deepEqual(out.reply, { t: 'correct', fix: 2, ack: 1, you: { ...s.you, vx: 0, vz: 0, speed: 0 }, reason: out.refused, tick: 1 })
  assert.equal(out.broadcast, undefined)
  assert.deepEqual([a.x, a.z, a.seq, a.fix, a.corrections], [at.x, at.z, 1, 2, 1])
  // Inputs the client sent before it applied the correction are dropped unread: no reply, nothing counted, no input
  // spent from the rate (a stall's backlog under the old correction costs the inputs after it nothing).
  const spent = a.buckets.input.tokens
  assert.deepEqual(handle(room, a, input(3, { ...lie, z: lie.z + 41 }, { ack: 1 }), 110, verify), {})
  assert.deepEqual([a.seq, a.fix, a.corrections, a.refusals], [1, 2, 1, 0])
  assert.ok(a.buckets.input.tokens >= spent)
  // …for as long as an honest client could still have one in flight; long after the correction one is a refusal.
  assert.equal(handle(room, a, input(3, STAND, { ack: 1 }), 100 + LIMITS.staleGraceMs + 1, verify).refused, 'input: under a correction long past')
  a.refusals = 0
  // Under the new correction, honest again.
  const next = honest(a, [[0, RUN, 6]])
  // (A refused input still spent its substeps: the budget is a second later.)
  assert.deepEqual(handle(room, a, input(4, next, { fix: 2, ack: 1, segs: [[0, RUN, 6]] }), 1100, verify), {})
  assert.equal(a.seq, 4)
  // A correction the room never made is a lie too.
  assert.match(handle(room, a, input(5, next, { fix: 9, ack: 1 }), 1200, verify).refused ?? '', /never made/)
})

test('input: more substeps than time allows, over rate, a stale seq or a future ack are corrected; too many corrections remove the peer', () => {
  const room = room0(10)
  const a = joined(room, 'Ada', 0)
  // The burst: half a second of substeps at once; the next substep in the same instant is a clock running fast.
  const burst = honest(a, [[0, 1, LIMITS.stepBurst]])
  assert.deepEqual(handle(room, a, input(1, burst, { segs: [[0, 1, LIMITS.stepBurst]] }), 0, verify), {})
  const fast = handle(room, a, input(2, honest(a, [[0, 1, 1]]), { fix: 1 }), 0, verify)
  assert.equal(fast.refused, 'input: more substeps than time allows')
  assert.equal((fast.reply as { t: string }).t, 'correct')
  // A sixtieth of a second later there is one substep to spend.
  assert.deepEqual(handle(room, a, input(3, honest(a, [[0, 1, 1]]), { fix: 2 }), 1000 / 60, verify), {})
  assert.equal(handle(room, a, input(3, STAND, { fix: 2 }), 2000, verify).refused, 'input: stale seq')
  assert.equal(handle(room, a, input(9, STAND, { fix: 3, ack: 5 }), 2000, verify).refused, 'input: ack from the future')
  // Over rate: the burst of inputs, then a correction at the same instant.
  const b = joined(room, 'Bob', 10_000)
  let seq = 0
  for (let i = 0; i < LIMITS.inputBurst; i++) assert.equal(handle(room, b, input(++seq, honest(b, [[0, 0, 0]]), { segs: [[0, 0, 0]] }), 10_000, verify).refused, undefined)
  const over = handle(room, b, input(++seq, STAND, { segs: [[0, 0, 0]] }), 10_000, verify)
  assert.deepEqual([over.refused, (over.reply as { t: string }).t, b.refusals], ['input: over rate', 'correct', 1], 'counted, and corrected')
  // A flood that ignores its corrections is still counted toward removal: past what a stall's backlog could hold, every
  // input under the old correction is a refusal.
  for (let i = 0; i < LIMITS.inputBurst; i++) assert.deepEqual(handle(room, b, input(++seq, STAND, { segs: [[0, 0, 0]] }), 10_000, verify), {}, `stale ${i}`)
  let kick: string | undefined
  for (let i = 1; i < LIMITS.refusalsBeforeKick; i++) kick = handle(room, b, input(++seq, STAND, { segs: [[0, 0, 0]] }), 10_000, verify).kick
  assert.equal(kick, 'repeated refusals')
  // A network stall of three seconds: the page kept stepping at 60 Hz and every input arrives at once. All are kept.
  const d = joined(room, 'Di', 30_000)
  for (let i = 1; i <= 3 * LIMITS.stepsPerSecond; i++) {
    const r = handle(room, d, input(i, honest(d, [[0, 1, 1]]), { segs: [[0, 1, 1]] }), 33_000, verify)
    assert.deepEqual(r, {}, `input ${i} after the stall`)
  }
  // Corrections a minute: the burst, then removal.
  const c = joined(room, 'Cy', 20_000)
  let kicked: string | undefined
  for (let i = 1; i <= LIMITS.correctionsPerMinute + 1 && !kicked; i++) {
    kicked = handle(room, c, input(i, { x: 999, y: 0, z: 0 }, { fix: c.fix }), 20_000, verify).kick
    if (i <= LIMITS.correctionsPerMinute) assert.equal(kicked, undefined, `correction ${i}`)
  }
  assert.equal(kicked, 'repeated illegal movement')
})

test('a malformed input frame from a joined peer is counted as a refusal and corrected; at the wheel and back on foot through the doors', () => {
  const room = room0()
  const a = joined(room, 'Ada', 0)
  const out = refuseInput(room, a, 'input: velocity', 0)
  assert.equal(out.refused, 'input: velocity')
  assert.equal((out.reply as { t: string; fix: number }).fix, 2)
  assert.equal(a.refusals, 1)
  // Into a car 3 m off (within the door), along the street at the cap, out at the kerb.
  const car = (x: number, z: number): CarBodyState => ({ x, y: 0.7, z, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 })
  const wheel = (n: number) => [[0.5, 0, 0, 0, n] as const]
  const drive = (seq: number, claim: { x: number; y: number; z: number }, fix: number, n: number, now: number, o: Partial<InputMessage> = {}) =>
    handle(room, a, input(seq, claim, { fix, mode: 'drive', segs: wheel(n), ...o }), now, verify)
  assert.match(drive(1, { x: 3, y: 0.7, z: 0 }, 2, 1, 0).refused ?? '', /at a wheel without taking one/)
  assert.match(drive(2, { x: 9, y: 0.7, z: 0 }, 3, 1, 0, { door: { enter: { car: 4, state: car(9, 0) } } }).refused ?? '', /out of the door's reach/)
  assert.deepEqual(drive(3, { x: 3, y: 0.7, z: 0 }, 4, 1, 0, { door: { enter: { car: 4, state: car(3, 0) } } }), {})
  assert.equal(a.driving, true)
  assert.deepEqual(drive(4, { x: 3, y: 0.7, z: 25 }, 4, 30, 1000), {})
  assert.ok(Math.abs(Math.hypot(a.vx, a.vz) - 50) < 1e-9, 'a car at the cap')
  assert.equal(poses(room)[0].driving, true)
  const fast = drive(5, { x: 3, y: 0.7, z: 60 }, 4, 30, 2000)
  assert.match(fast.refused ?? '', /cannot cover 35\.0 m/)
  // A correction at the wheel keeps the player there and carries the car: its state, at rest where it was kept.
  const fix = fast.reply as { t: 'correct'; fix: number; you: RemotePlayer; car?: { index: number; state: CarBodyState } }
  assert.deepEqual([fix.you.driving, fix.you.x, fix.you.z, fix.fix], [true, 3, 25, 5])
  assert.deepEqual(fix.car, { index: 4, state: { ...car(3, 25) } })
  assert.ok(readServerMessage(fix).ok, 'the page reads it as the host sent it')
  // On foot again only through a door out, within reach of the car.
  const kerb = { x: 5, z: 25 }
  const walk = planeStep(kerb, [[0, 0, 1]])
  assert.match(handle(room, a, input(6, walk, { fix: 5 }), 3100, verify).refused ?? '', /without leaving the car/)
  assert.match(handle(room, a, input(7, walk, { fix: 6, door: { exit: { x: 30, z: 25 } } }), 3200, verify).refused ?? '', /out of reach/)
  assert.deepEqual(handle(room, a, input(8, walk, { fix: 7, door: { exit: kerb } }), 3300, verify), {})
  assert.deepEqual([a.driving, a.x, a.z], [false, walk.x, walk.z])
  // A correction on foot carries no car.
  assert.equal((refuseInput(room, a, 'input: runs', 3400).reply as { car?: unknown }).car, undefined)
})

test('at the wheel the substeps are spent as on foot: a run\'s last entry, never its steer (found by protocol.fuzz.test.ts)', () => {
  const room = room0()
  const a = joined(room, 'Ada', 0)
  const st = { x: 1, y: 0.7, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
  assert.deepEqual(handle(room, a, input(1, { x: 1, y: 0.7, z: 0 }, { mode: 'drive', segs: [[0, 0, 0, 0, 0]], door: { enter: { car: 0, state: st } } }), 0, verify), {})
  // The whole bank in full inputs at the wheel (the steer 0.1, which a count of the wrong entry would read as nothing)…
  let seq = 1
  for (let k = 0; k < LIMITS.stepBurst / LIMITS.stepsPerInput; k++) {
    assert.deepEqual(handle(room, a, input(++seq, { x: 1, y: 0.7, z: 0 }, { mode: 'drive', segs: [[1, 0, 0.1, 0, LIMITS.stepsPerInput]] }), 0, verify), {}, `burst ${k}`)
  }
  // …and one more at once is a clock running fast, at the wheel as on foot.
  const fast = handle(room, a, input(++seq, { x: 1, y: 0.7, z: 0 }, { mode: 'drive', segs: [[1, 0, 0.1, 0, 1]] }), 0, verify)
  assert.equal(fast.refused, 'input: more substeps than time allows')
})

test('doors: more than time allows are corrected, whatever they say (a hop chain is no faster than the door rate)', () => {
  const room = room0()
  const a = joined(room, 'Ada', 0)
  const st = { x: 1, y: 0.7, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
  let seq = 0
  const hop = (now: number) => {
    const into = handle(room, a, input(++seq, { x: a.x + 1, y: 0.7, z: a.z }, { fix: a.fix, mode: 'drive', segs: [[0, 0, 0, 0, 0]], door: { enter: { car: 0, state: { ...st, x: a.x + 1, z: a.z } } } }), now, verify)
    const out = handle(room, a, input(++seq, planeStep({ x: a.x + 2, z: a.z }, [[0, 0, 0]]), { fix: a.fix, door: { exit: { x: a.x + 2, z: a.z } } }), now, verify)
    return [into.refused, out.refused]
  }
  for (let i = 0; i < LIMITS.doorBurst / 2; i++) assert.deepEqual(hop(0), [undefined, undefined], `pair ${i}`)
  assert.equal(hop(0)[0], 'input: more doors than time allows')
  // A pair's worth of time (two doors at LIMITS.doorsPerSecond) refills a pair.
  assert.equal(a.driving, false)
  assert.deepEqual(hop(Math.ceil(2000 / LIMITS.doorsPerSecond)), [undefined, undefined])
})

test('chat and ping: relayed to the room with the sender\'s id and name; inadmissible chat is dropped silently; over rate and stale seq refused', () => {
  const room = room0()
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
  const room = room0()
  const a = joined(room, 'Ada', 0)
  for (let i = 1; i < LIMITS.refusalsBeforeKick; i++) {
    const out = i % 2 ? refuse(a, 'not JSON', 0) : handle(room, a, { t: 'chat', seq: i, text: 'you moron' }, 0, verify)
    assert.equal(out.kick, undefined, `refusal ${i}`)
  }
  const last = refuse(a, 'not JSON', 0)
  assert.deepEqual(last, { refused: 'not JSON', kick: 'repeated refusals' })
  assert.equal(a.refusals, LIMITS.refusalsBeforeKick)
})

/**
 * The worst authority for a hopper: it keeps every input, moves the player along +x a run's worth for each substep,
 * and grants every door its full reach (into a car 3.81 m, out 2.1 m), keeping apart how far the doors carried it.
 */
function hopAuthority(): Authority & { at: Map<number, Truth>; hopped: number } {
  const at = new Map<number, Truth>()
  const truth = (x: number, driving: boolean): Truth => ({ x, y: PLANE.standing, z: 0, heading: 0, vx: 0, vz: 0, speed: 0, driving })
  const a = {
    world: 'hop',
    at,
    hopped: 0,
    join(id: number) { at.set(id, truth(0, false)); return at.get(id)! },
    leave(id: number) { at.delete(id) },
    judge(id: number, m: InputMessage) {
      const t = at.get(id)!
      let x = t.x
      for (const r of m.segs) x += (r[r.length - 1] * RUN) / 60
      if (m.door) {
        const reach = 'enter' in m.door ? ENTER_RANGE + GARAGE.enterSlack : EXIT_SIDE
        x += reach
        a.hopped += reach
      }
      at.set(id, truth(x, m.door ? 'enter' in m.door : t.driving))
      return { ok: true as const, pose: at.get(id)! }
    },
    settle(id: number) { return at.get(id)! },
  }
  return a
}

test('hopping from car to car is no faster than a run: a pair reaches at most 5.91 m, and the door rate keeps a hop chain under RUN', () => {
  const pair = ENTER_RANGE + GARAGE.enterSlack + EXIT_SIDE
  assert.ok((pair * LIMITS.doorsPerSecond) / 2 <= RUN, `a chain at the door rate: ${((pair * LIMITS.doorsPerSecond) / 2).toFixed(2)} m/s`)
  const state = { x: 0, y: 0.56, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
  forAll('hops', { seed: 0x40b, runs: 60 }, (g) => ({ doorEvery: g.int(1, 40), steps: g.int(0, 3), frames: g.int(600, 2400) }), ({ doorEvery, steps, frames }) => {
    const authority = hopAuthority()
    const room = createRoom(authority)
    const p = admit(room, 0)!
    handle(room, p, { t: 'join', v: PROTOCOL_VERSION, token: GOOD, name: 'Hop', world: 'hop' }, 0, verify)
    let seq = 0
    let fix = p.fix
    for (let f = 1; f <= frames; f++) {
      const now = (f * 1000) / 60
      const driving = authority.at.get(p.id)!.driving
      const door = f % doorEvery === 0 ? (driving ? { exit: { x: 0, z: 0 } } : { enter: { car: 0, state } }) : undefined
      const mode = (door ? 'enter' in door : driving) ? 'drive' : 'foot'
      const segs = mode === 'drive' ? [[1, 0, 0, 0, steps]] : [[RUN, 0, steps]]
      const out = handle(room, p, { t: 'input', seq: ++seq, ack: 0, fix, mode, segs, heading: 0, claim: STAND, ...(door && { door }) } as unknown as InputMessage, now, verify)
      if (out.reply?.t === 'correct') fix = out.reply.fix
      if (out.kick) break
      const s = now / 1000
      // The doors alone: never past a run since the start, but for the door burst's reach.
      const hops = RUN * s + LIMITS.doorBurst * (ENTER_RANGE + GARAGE.enterSlack) + 1e-9
      assert.ok(authority.hopped <= hops, `frame ${f}: the doors carried ${authority.hopped.toFixed(2)} m, past ${hops.toFixed(2)}`)
      // The runs between them add at most a run more (and the substep bank).
      const both = hops + RUN * s * LIMITS.headroom + (LIMITS.stepBurst * RUN) / 60
      assert.ok(p.x <= both, `frame ${f}: the truth is ${p.x.toFixed(2)} m along, past ${both.toFixed(2)}`)
    }
  })
})

test('a kept input the page drifted from is put back (drift): on foot no correction number is spent and nothing in flight is dropped; never a refusal, never counted toward removal', () => {
  const base = planeAuthority()
  const authority: Authority = { ...base, judge: (id, m) => { const v = base.judge(id, m); return v.ok ? { ...v, resync: 'claim 5.0 µm from the plane\'s pose' } : v } }
  const room = createRoom(authority)
  const a = admit(room, 0)!
  handle(room, a, { t: 'join', v: PROTOCOL_VERSION, token: GOOD, name: 'Ada', world: 'plane' }, 0, verify)
  const tokens = a.buckets.corrections.tokens
  for (let k = 1; k <= 40; k++) {
    const out = handle(room, a, input(k, honest(a, [[0, RUN, 1]]), { fix: a.fix, segs: [[0, RUN, 1]] }), k * 100, verify)
    assert.equal(out.refused, undefined, `input ${k}`)
    assert.equal(out.kick, undefined)
    const reply = out.reply as { t: string; drift?: boolean; ack: number; fix: number }
    // The same correction number: every input the page sent after this one, under it, is still read (none dropped).
    assert.deepEqual([reply.t, reply.drift, reply.ack, reply.fix], ['correct', true, k, 1], 'kept (acknowledged), the page shifted, not rewound')
  }
  assert.deepEqual([a.seq, a.fix, a.corrections, a.refusals, a.resyncs], [40, 1, 0, 0, 40])
  assert.equal(a.buckets.corrections.tokens, tokens, 'the corrections allowance untouched')
  // On the wire: drift is true or absent.
  const c = { t: 'correct', fix: 2, ack: 1, you: player(1), reason: 'r', tick: 1 }
  const read = readServerMessage({ ...c, drift: true })
  assert.ok(read.ok && read.msg.t === 'correct' && read.msg.drift === true)
  assert.ok(readServerMessage(c).ok && !('drift' in (readServerMessage(c) as { msg: object }).msg), 'absent stays absent')
  assert.ok(!readServerMessage({ ...c, drift: false }).ok)
  assert.ok(!readServerMessage({ ...c, drift: 'yes' }).ok)
})

test('the refusal allowance comes back: an honest client\'s rare refusal never adds up over a long session, a stream of them still removes a peer', () => {
  const room = room0()
  const a = joined(room, 'Ada', 0)
  // One refusal every 20 s for an hour (the allowance comes back at one every 15 s): never removed.
  for (let t = 0; t < 3_600_000; t += 20_000) assert.equal(refuse(a, 'input: under a correction long past', t).kick, undefined, `at ${t / 1000} s`)
  assert.equal(a.refusals, 180, 'every one still counted')
  // Then a burst: the eighth in a row removes the peer, as from a standing start.
  const t = 3_600_000
  for (let i = 1; i < LIMITS.refusalsBeforeKick; i++) assert.equal(refuse(a, 'not JSON', t).kick, undefined, `refusal ${i}`)
  assert.equal(refuse(a, 'not JSON', t).kick, 'repeated refusals')
  // Seven in a burst, then the eighth after the allowance has come back by one: still in.
  const b = joined(room, 'Bob', 0)
  for (let i = 1; i < LIMITS.refusalsBeforeKick; i++) refuse(b, 'not JSON', 0)
  assert.equal(refuse(b, 'not JSON', 60_000 / LIMITS.refusalsPerMinute).kick, undefined)
  assert.equal(refuse(b, 'not JSON', 60_000 / LIMITS.refusalsPerMinute).kick, 'repeated refusals')
})

test('expired: a peer that never joined is dropped after the join timeout, a silent one after the idle timeout', () => {
  const room = room0()
  const a = admit(room, 0)!
  const b = joined(room, 'Bob', 0)
  assert.deepEqual(expired(room, LIMITS.joinTimeoutMs - 1), [])
  assert.deepEqual(expired(room, LIMITS.joinTimeoutMs).map((e) => [e.peer.id, e.reason]), [[a.id, 'join timeout']])
  handle(room, b, { t: 'ack', ack: 0 }, 10_000, verify)
  assert.deepEqual(expired(room, 10_000 + LIMITS.idleTimeoutMs).map((e) => [e.peer.id, e.reason]), [[a.id, 'join timeout'], [b.id, 'idle']])
})

test('deterministic: two rooms fed the same messages on the same clock give the same snapshots and corrections', () => {
  const run = (): unknown[] => {
    const room = room0(30)
    const a = joined(room, 'Ada', 0)
    const b = joined(room, 'Bob', 1)
    const out: unknown[] = []
    for (let i = 1; i <= 50; i++) {
      const runs: FootRun[] = [[Math.sin(i) * RUN, Math.cos(i) * 3, 1 + (i % 2)]]
      const claim = honest(a, runs)
      if (i % 7 === 0) claim.z += 1
      const r = handle(room, a, input(i, claim, { ack: room.tick, fix: a.fix, segs: runs }), i * 33, verify)
      if (r.reply) out.push(r.reply)
      if (i % 3 === 0) handle(room, b, input(i, honest(b, [[2, -2, 1]]), { ack: room.tick, segs: [[2, -2, 1]] }), i * 33, verify)
      tickRoom(room)
      out.push(snapshotFor(room, a))
    }
    return out
  }
  const one = run()
  assert.deepEqual(one, run())
  assert.ok(one.some((m) => (m as { t: string }).t === 'correct'), 'the lies were corrected')
})

test('snapshots: every other player in millimetres, the peer itself exact; a full room fits the host\'s bound', () => {
  const room = room0()
  const peers: Peer[] = []
  for (let i = 0; i < LIMITS.peers; i++) peers.push(joined(room, `Player ${String(i).padStart(2, '0')} longname`, 0))
  for (const p of peers) {
    p.x = 1234.567891234 + p.id
    p.z = -2345.678912345
    p.vx = 1.23456789
  }
  const s = snapshotFor(room, peers[0])
  assert.equal(s.you.x, peers[0].x, 'exact')
  assert.equal(s.players.length, LIMITS.peers - 1)
  assert.equal(s.players[0].x, Math.round((1234.567891234 + 2) * 1000) / 1000)
  assert.equal(s.players[0].vx, 1.235)
  const wire = sealMessage(s, 1e9, 'x'.repeat(LIMITS.token))
  assert.ok(wire.length <= LIMITS.hostMessage, `${wire.length} bytes`)
  assert.ok(decodeServerMessage(encode(s)).ok)
})

// ---------------------------------------------------------------- the replica

test('reconcile: the host\'s word replaces every remote pose and the client\'s truth; a stale snapshot is ignored; the result is frozen', () => {
  const r0 = emptyReplica(2)
  assert.equal(r0.you, null)
  const s1: SnapshotMessage = { t: 'snapshot', tick: 5, ack: 3, fix: 1, you: player(2, { x: 9 }), players: [player(3, { x: 1 }), player(2, { x: 9 }), player(1, { x: 2 })] }
  const r1 = reconcile(r0, s1)
  assert.deepEqual(r1.players.map((p) => [p.id, p.x]), [[1, 2], [3, 1]], 'by rising id, self gone')
  assert.deepEqual([r1.tick, r1.ack, r1.fix, r1.you?.x], [5, 3, 1, 9])
  assert.ok(Object.isFrozen(r1) && Object.isFrozen(r1.players))
  assert.equal(reconcile(r1, { ...s1, tick: 5, ack: 4 }), r1, 'a repeat is ignored')
  assert.equal(reconcile(r1, { ...s1, tick: 4, ack: 4 }), r1, 'an older one is ignored')
  const r2 = reconcile(r1, { t: 'snapshot', tick: 6, ack: 2, fix: 0, you: player(2, { x: 10 }), players: [player(1, { x: 3 })] })
  assert.deepEqual(r2.players.map((p) => [p.id, p.x]), [[1, 3]], 'player 3 is gone when the host no longer lists it')
  assert.deepEqual([r2.ack, r2.fix, r2.you?.x], [3, 1, 10], 'ack and fix never fall')
  assert.deepEqual(reconcile(r0, s1), r1, 'deterministic')
  const inputs = [1, 2, 3, 4].map((seq) => input(seq, STAND))
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
  const b = player(1, { heading: -3, x: 10, driving: true })
  const m = blend(a, b, 0.5)
  assert.equal(m.x, 5)
  assert.equal(m.driving, true)
  assert.ok(Math.abs(Math.abs(m.heading) - Math.PI) < 1e-9, `through π, not through 0: ${m.heading}`)
  assert.deepEqual(blend(a, b, 0), { ...a, id: b.id, name: b.name, driving: true })
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

// ---------------------------------------------------------------- sealed frames

test('sealed frames: numbered and signed under the session token over the canonical body; a forgery, an altered field or a replay is refused and moves nothing', () => {
  const room = room0()
  const peer = admit(room, 0)!
  const join: ClientMessage = { t: 'join', v: PROTOCOL_VERSION, token: GOOD, name: 'Ada', world: 'plane' }
  const wire = sealMessage(join, 1, GOOD)
  const env = JSON.parse(wire) as { n: number; body: unknown; mac: string }
  assert.deepEqual(Object.keys(env).sort(), ['body', 'mac', 'n'])
  assert.deepEqual(env.body, join)
  assert.equal(env.mac, hmacSha256(GOOD, canonical({ n: 1, body: join })), 'the HMAC of the number and the canonical body')
  assert.equal(sealMessage({ t: 'leave' }, 1, GOOD), sealMessage({ t: 'leave' }, 1, GOOD), 'deterministic')
  assert.equal(sealMessage({ t: 'leave' }, 1, GOOD, (k, m) => hmacSha256(k, m)), sealMessage({ t: 'leave' }, 1, GOOD), 'the MAC is pluggable, the digest the same')
  assert.throws(() => sealMessage({ t: 'leave' }, -1, GOOD), RangeError)
  // Before the join only a join is read, under the token it carries; the room then verifies that token itself.
  assert.deepEqual(openClientFrame(peer, sealMessage({ t: 'ack', ack: 0 }, 1, GOOD)), { ok: false, reason: 'ack before join' })
  assert.deepEqual(openClientFrame(peer, sealMessage(join, 1, 'other')), { ok: false, reason: 'envelope: bad seal' }, 'sealed under another token than it carries')
  assert.equal(peer.received, 0)
  const opened = openClientFrame(peer, wire)
  assert.ok(opened.ok)
  assert.deepEqual(opened.msg, join)
  assert.equal(peer.received, 1)
  assert.equal(handle(room, peer, opened.msg, 0, verify).refused, undefined)
  assert.equal(peer.key, GOOD, 'the token the peer joined with seals everything after, both ways')
  // Joined: the seal under the peer's token, the envelope number rising.
  const frame = (seq: number, n: number, key = GOOD): string => sealMessage(input(seq, STAND), n, key)
  assert.ok(openClientFrame(peer, frame(1, 2)).ok)
  assert.deepEqual(openClientFrame(peer, frame(2, 2)), { ok: false, reason: 'envelope: replayed' })
  assert.deepEqual(openClientFrame(peer, frame(2, 1)), { ok: false, reason: 'envelope: replayed' })
  assert.deepEqual(openClientFrame(peer, frame(2, 3, 'other')), { ok: false, reason: 'envelope: bad seal' })
  assert.equal(peer.received, 2, 'a refusal moves nothing')
  // One field altered after sealing (the claim moved 40 m), a field added, the number changed, one hex digit of the seal.
  const good = JSON.parse(frame(3, 3)) as { n: number; body: Record<string, unknown>; mac: string }
  const flipped = `${good.mac[0] === 'a' ? 'b' : 'a'}${good.mac.slice(1)}`
  const moved = { ...good, body: { ...good.body, claim: { ...(good.body.claim as object), z: 40 } } }
  for (const altered of [moved, { ...good, body: { ...good.body, extra: 1 } }, { ...good, n: 4 }, { ...good, mac: flipped }]) {
    assert.deepEqual(openClientFrame(peer, JSON.stringify(altered)), { ok: false, reason: 'envelope: bad seal' }, JSON.stringify(altered))
  }
  assert.ok(openClientFrame(peer, JSON.stringify(good)).ok, 'the genuine frame still passes')
  assert.ok(openClientFrame(peer, frame(4, 1_000_000)).ok, 'a gap in the numbers is not a replay')
  // The envelope's own shape, bounded like any frame; JSON that is not plain data is refused, not thrown on.
  const mac = 'a'.repeat(64)
  const shapes: [unknown, RegExp][] = [
    [7, /not text/], ['{', /not JSON/], ['[]', /not an envelope/], ['{"n":-1}', /envelope: n/], ['{"n":1,"mac":"x"}', /envelope: mac/],
    [`{"n":1,"mac":"${mac}","body":1}`, /envelope: body/], [`{"n":1,"mac":"${mac}","body":{"t":"leave","x":1e999}}`, /envelope: body/],
    [`{"n":1,"mac":"${mac}","body":{"t":"step"}}`, /unknown message "step"/],
  ]
  for (const [bad, why] of shapes) {
    const r = openClientFrame(peer, bad)
    assert.ok(!r.ok && why.test(r.reason), `${String(bad)} → ${r.ok ? 'ok' : r.reason}`)
  }
  const long = openClientFrame(peer, sealMessage({ t: 'chat', seq: 1, text: 'x' }, 9, GOOD).padEnd(LIMITS.message + 1))
  assert.ok(!long.ok && /longer than/.test(long.reason))
  assert.equal(peer.received, 1_000_000, 'none of it moved the peer')
})

test('the page opens the host\'s frames the same way: under the session token, numbered above the last, bounded at hostMessage; the validator still reads the body', () => {
  const key = 'session-token'
  const welcome: ServerMessage = { t: 'welcome', v: PROTOCOL_VERSION, id: 1, tick: 0, tickHz: 20, fix: 1, you: player(1), players: [] }
  const a = openServerFrame(sealMessage(welcome, 1, key), key, 0)
  assert.ok(a.ok)
  assert.deepEqual([a.msg, a.n], [welcome, 1])
  assert.deepEqual(openServerFrame(sealMessage(welcome, 1, key), key, 1), { ok: false, reason: 'envelope: replayed' })
  assert.deepEqual(openServerFrame(sealMessage(welcome, 2, 'other'), key, 1), { ok: false, reason: 'envelope: bad seal' })
  const named = { t: 'snapshot' as const, tick: 1, ack: 0, fix: 1, you: player(1), players: [player(2, { name: 'you idiot' })] }
  assert.deepEqual(openServerFrame(sealMessage(named, 2, key), key, 1), { ok: false, reason: 'snapshot: players' })
  assert.deepEqual(openServerFrame(encode(welcome), key, 0), { ok: false, reason: 'envelope: n' }, 'an unsealed message is not a frame')
  assert.deepEqual(openServerFrame(undefined, key, 0), { ok: false, reason: 'not text' })
  const big = sealMessage({ ...named, players: [] }, 3, key).padEnd(LIMITS.message + 100)
  assert.ok(openServerFrame(big, key, 2).ok, 'a host frame may be longer than a client\'s')
  assert.match((openServerFrame(big.padEnd(LIMITS.hostMessage + 1), key, 2) as { reason: string }).reason, /longer than/)
})
