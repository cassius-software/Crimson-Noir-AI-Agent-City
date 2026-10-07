/**
 * Why does this file exist? It is the property-based fuzzing of the protocol core (replication.ts), seeded and
 * replayable (02_Define_The_Rules/property.ts): the validators are total (no input, however malformed, throws), closed
 * (whatever they accept is deeply frozen, every number in it finite and inside LIMITS, nothing extra) and idempotent
 * (an accepted message read again off the wire is the same message), for tens of thousands of near misses of every
 * message either side sends; a sealed frame survives only untouched and only once (any byte changed, any envelope
 * number not rising, any other key, refused); and the room keeps its invariants under adversarial streams on a
 * chaotic clock (honest, mutated, duplicated, reordered and replayed inputs, stale and future corrections, doors and
 * bursts past their rates, jitter and stalls): a peer's kept seq and correction number only rise, it never keeps more
 * substeps or doors than time allows, its truth moves only when an input is kept, a refusal past the limit removes it,
 * and two rooms fed the same stream agree to the bit.
 * What breaks if it is removed? A message shape nobody thought of could crash the host or slip past a bound, a forged
 * frame could find a gap in the seal, or a stream nobody tried could buy a peer more time than the clock gives.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deeplyFrozen, forAll, gen, mutate, nastyNumber, numbersIn, type Gen } from '../02_Define_The_Rules/property.ts'
import { RUN } from '../07_Execute_Actions/simProtocol.ts'
import { planeAuthority, planeStep } from './plane.node.ts'
import {
  admit, createRoom, decodeClientMessage, decodeServerMessage, handle, LIMITS, openClientFrame, openServerFrame, PROTOCOL_VERSION, readClientMessage,
  readServerMessage, refuseInput, sealMessage, tickRoom,
  type ClientMessage, type InputMessage, type Peer, type Room, type ServerMessage,
} from './replication.ts'

const STATE = { x: 101.5, y: 0.56, z: 202.25, qx: 0, qy: 0.6, qz: 0, qw: 0.8, vx: 3, vy: -0.01, vz: 4, wx: 0.01, wy: 0.2, wz: -0.01 }
const CLIENT: readonly unknown[] = [
  { t: 'join', v: PROTOCOL_VERSION, token: 'abc.123.x_y', name: 'Ada', world: 'city/1337/36' },
  { t: 'input', seq: 3, ack: 2, fix: 1, mode: 'foot', segs: [[1, -1, 2], [RUN, 0, 3]], heading: 0.5, claim: { x: 1, y: 0.92, z: -1 } },
  { t: 'input', seq: 4, ack: 2, fix: 1, mode: 'drive', segs: [[0.7, 0, 0.2, 0, 5], [-0.5, 2, -0.6, 1, 1]], heading: 1, claim: { x: 30, y: 0.56, z: 2 } },
  { t: 'input', seq: 5, ack: 2, fix: 1, mode: 'drive', segs: [[0, 0, 0, 0, 0]], heading: 1, claim: { x: 101.5, y: 0.56, z: 202.25 }, door: { enter: { car: 7, state: STATE } } },
  { t: 'input', seq: 6, ack: 2, fix: 1, mode: 'foot', segs: [[0, 0, 1]], heading: 1, claim: { x: 99, y: 0.95, z: 202 }, door: { exit: { x: 99, z: 202 } } },
  { t: 'ack', ack: 9 },
  { t: 'chat', seq: 1, text: 'Could you bring the forms?' },
  { t: 'ping', seq: 2, kind: 'gather', x: 1, y: 2, z: 3 },
  { t: 'leave' },
]
const player = (id: number, o: Record<string, unknown> = {}) => ({ id, name: `p${id}`, x: 1, y: 0.92, z: 2, heading: 0.1, vx: 1, vz: 0, speed: 1, driving: false, ...o })
const SERVER: readonly unknown[] = [
  { t: 'welcome', v: PROTOCOL_VERSION, id: 1, tick: 3, tickHz: 20, fix: 1, you: player(1), players: [player(2), player(3, { driving: true, vx: 30, speed: 30 })] },
  { t: 'snapshot', tick: 4, ack: 3, fix: 1, you: player(1), players: [player(2)] },
  { t: 'correct', fix: 2, ack: 3, you: player(1), reason: 'claim 40.00 m from the mirror\'s pose', tick: 4 },
  { t: 'correct', fix: 3, ack: 3, you: player(1, { x: STATE.x, y: STATE.y, z: STATE.z, driving: true }), reason: 'chassis', tick: 4, car: { index: 7, state: STATE } },
  { t: 'chat', from: 2, name: 'Bob', text: 'hello', tick: 5 },
  { t: 'ping', from: 2, kind: 'go', x: 1, y: 0, z: 2, tick: 5 },
  { t: 'joined', player: player(4), tick: 6 },
  { t: 'left', id: 4, reason: 'left', tick: 7 },
]

/** The bounds every accepted client message keeps, checked independently of the validator. */
function withinBounds(m: ClientMessage): void {
  for (const n of numbersIn(m)) assert.ok(Number.isFinite(n), `a non-finite number got through: ${n}`)
  if (m.t !== 'input') return
  let total = 0
  for (const r of m.segs) {
    const n = r[r.length - 1]
    assert.ok(Number.isInteger(n) && n >= 0)
    total += n
    if (m.mode === 'foot') {
      assert.equal(r.length, 3)
      assert.ok(Math.abs(r[0]) <= RUN && Math.abs(r[1]) <= RUN)
    } else {
      assert.equal(r.length, 5)
      assert.ok(Math.abs(r[0]) <= LIMITS.throttle && r[1] >= 0 && r[1] <= LIMITS.brake && Math.abs(r[2]) <= LIMITS.steer && (r[3] === 0 || r[3] === 1))
    }
  }
  assert.ok(total <= LIMITS.stepsPerInput && m.segs.length >= 1 && m.segs.length <= LIMITS.runs)
  assert.ok(Math.abs(m.claim.x) <= LIMITS.range && Math.abs(m.claim.z) <= LIMITS.range && Math.abs(m.claim.y) <= LIMITS.height)
  if (m.door && 'enter' in m.door) {
    const s = m.door.enter.state
    assert.equal(m.mode, 'drive')
    assert.ok(Number.isInteger(m.door.enter.car) && m.door.enter.car >= 0 && m.door.enter.car < LIMITS.cars)
    const q = Math.hypot(s.qx, s.qy, s.qz, s.qw)
    assert.ok(q > 0.99 && q < 1.01 && Math.hypot(s.vx, s.vy, s.vz) <= LIMITS.driveSpeed)
    assert.deepEqual(Object.keys(s).sort(), ['qw', 'qx', 'qy', 'qz', 'vx', 'vy', 'vz', 'wx', 'wy', 'wz', 'x', 'y', 'z'])
  } else if (m.door) {
    assert.equal(m.mode, 'foot')
    assert.deepEqual(Object.keys(m.door.exit).sort(), ['x', 'z'])
  }
}

/** JSON's own reading of a message (signed zero is the one thing JSON does not keep). */
const wire = (u: unknown): string => JSON.stringify(u)

test('the client validator is total, closed and idempotent over 30,000 near misses of every message a page sends', () => {
  let accepted = 0
  forAll('readClientMessage', { seed: 0xc0ffee, runs: 30_000 }, (g) => mutate(g.pick(CLIENT), g, g.int(1, 3)), (m) => {
    const r = readClientMessage(m)
    if (!r.ok) {
      assert.equal(typeof r.reason, 'string')
      return
    }
    accepted++
    assert.ok(deeplyFrozen(r.msg), 'frozen all the way down')
    withinBounds(r.msg)
    const again = decodeClientMessage(wire(r.msg))
    assert.ok(again.ok, `read again: ${again.ok ? '' : again.reason}`)
    assert.equal(wire(again.msg), wire(r.msg), 'the same message off the wire')
  })
  assert.ok(accepted > 1000, `${accepted} near misses were still well formed (the property saw both sides)`)
})

test('the host validator is total, closed and idempotent over 20,000 near misses of every message a host sends', () => {
  let accepted = 0
  forAll('readServerMessage', { seed: 0xbadcafe, runs: 20_000 }, (g) => mutate(g.pick(SERVER), g, g.int(1, 3)), (m) => {
    const r = readServerMessage(m)
    if (!r.ok) return
    accepted++
    assert.ok(deeplyFrozen(r.msg))
    for (const n of numbersIn(r.msg)) assert.ok(Number.isFinite(n))
    const msg: ServerMessage = r.msg
    if (msg.t === 'correct' && msg.car) assert.ok(msg.you.driving && msg.car.state.x === msg.you.x && msg.car.state.z === msg.you.z)
    const again = decodeServerMessage(wire(msg))
    assert.ok(again.ok)
    assert.equal(wire(again.msg), wire(msg))
  })
  assert.ok(accepted > 1000, `${accepted} accepted`)
})

test('decoding never throws: random text, truncations and splices of real frames', () => {
  const frames = CLIENT.map((m, i) => sealMessage(m as ClientMessage, i + 1, 'key'))
  forAll('decode', { seed: 7, runs: 20_000 }, (g) => {
    const f = g.pick(frames)
    switch (g.int(0, 3)) {
      case 0: return f.slice(0, g.int(0, f.length))
      case 1: return f.slice(0, g.int(0, f.length)) + g.pick(frames).slice(g.int(0, 40))
      case 2: return Array.from({ length: g.int(0, 200) }, () => String.fromCharCode(g.int(0, 0xffff))).join('')
      default: return `{"n":${g.pick(['1', '1e999', '-1', '"1"', 'null'])},"body":${wire(mutate(g.pick(CLIENT), g))},"mac":"${'0'.repeat(64)}"}`
    }
  }, (text) => {
    decodeClientMessage(text)
    decodeServerMessage(text)
    openServerFrame(text, 'key', 0)
  })
})

test('a sealed frame is accepted untouched and once; any character changed, any other key, any number that does not rise is refused', () => {
  forAll('seal', { seed: 0x5ea1, runs: 6000 }, (g) => {
    const msg = g.pick(CLIENT.slice(1)) as ClientMessage
    const n = g.int(1, 1000)
    const frame = sealMessage(msg, n, 'the-token')
    const i = g.int(0, frame.length - 1)
    const flipped = frame.slice(0, i) + String.fromCharCode(frame.charCodeAt(i) ^ (1 << g.int(0, 6))) + frame.slice(i + 1)
    return { msg, n, frame, flipped, other: sealMessage(msg, n, 'another-token'), behind: g.int(0, n) }
  }, ({ n, frame, flipped, other, behind }) => {
    const peer = (received: number): Peer => ({ joined: true, key: 'the-token', received } as unknown as Peer)
    const p = peer(n - 1)
    assert.ok(openClientFrame(p, frame).ok, 'untouched')
    assert.equal(p.received, n)
    assert.ok(!openClientFrame(p, frame).ok, 'once')
    const q = peer(n - 1)
    const f = openClientFrame(q, flipped)
    // A change can land in a place the canonical body does not see (JSON whitespace cannot be flipped into); anything
    // else must be refused, and a refused frame moves nothing.
    if (f.ok) assert.equal(JSON.stringify(JSON.parse(flipped)), JSON.stringify(JSON.parse(frame)))
    else assert.equal(q.received, n - 1)
    assert.ok(!openClientFrame(peer(n - 1), other).ok, 'another key')
    assert.ok(!openClientFrame(peer(Math.max(n, behind)), frame).ok, 'a number that does not rise')
  })
})

// ---------------------------------------------------------------- the room under adversarial streams

const GOOD = 'good-token'
const verify = (t: string): boolean => t === GOOD

interface Session {
  room: Room
  peers: Peer[]
  log: unknown[]
}

/**
 * One adversarial session: `n` peers on the open plane, each sending a random mix (honest runs, near misses of its own
 * input, replays of an earlier one, a stale or a future correction, doors and bursts past their rates, chat and acks)
 * on a clock that jitters, stalls and races. Every invariant is checked after every message; the log is everything the
 * room said, for the determinism check.
 */
function session(g: Gen, peersN: number, messages: number): Session {
  const room = createRoom(planeAuthority('plane'), 20)
  const peers: Peer[] = []
  let now = 0
  for (let k = 0; k < peersN; k++) {
    const p = admit(room, now)!
    handle(room, p, { t: 'join', v: PROTOCOL_VERSION, token: GOOD, name: `P${k}`, world: 'plane' }, now, verify)
    peers.push(p)
  }
  const log: unknown[] = []
  const sent: InputMessage[][] = peers.map(() => [])
  const seqs = peers.map(() => 0)
  const keptSteps = peers.map(() => 0)
  const keptDoors = peers.map(() => 0)
  const start = now
  const state = (x: number, z: number) => ({ x, y: 0.7, z, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 })
  for (let i = 0; i < messages; i++) {
    // The clock: mostly a frame, sometimes a burst at once, sometimes a stall of up to four seconds.
    const roll = g.next()
    now += roll < 0.6 ? g.float(0, 34) : roll < 0.9 ? 0 : g.float(500, 4000)
    if (g.bool(0.05)) tickRoom(room)
    const k = g.int(0, peers.length - 1)
    const p = peers[k]
    if (!room.peers.has(p.id)) continue
    const before = { x: p.x, y: p.y, z: p.z, seq: p.seq, fix: p.fix, refusals: p.refusals, driving: p.driving }
    let msg: unknown
    const kind = g.next()
    const n = g.int(0, 30)
    if (kind < 0.35) {
      // Honest: a walk, a drive, or a door, under the current correction.
      const seq = ++seqs[k]
      if (p.driving) {
        const exit = g.bool(0.15)
        if (exit) msg = { t: 'input', seq, ack: room.tick, fix: p.fix, mode: 'foot', segs: [[0, 0, n]], heading: 0, claim: planeStep({ x: p.x + 2, z: p.z }, [[0, 0, n]]), door: { exit: { x: p.x + 2, z: p.z } } }
        else msg = { t: 'input', seq, ack: room.tick, fix: p.fix, mode: 'drive', segs: [[0.5, 0, 0, 0, n]], heading: 0, claim: { x: p.x, y: 0.7, z: p.z + g.float(0, n * 0.8) } }
      } else if (g.bool(0.2)) {
        msg = { t: 'input', seq, ack: room.tick, fix: p.fix, mode: 'drive', segs: [[0.5, 0, 0, 0, n]], heading: 0, claim: { x: p.x + 2, y: 0.7, z: p.z }, door: { enter: { car: g.int(0, 47), state: state(p.x + 2, p.z) } } }
      } else {
        const v = [g.float(-RUN, RUN), g.float(-RUN, RUN)]
        msg = { t: 'input', seq, ack: room.tick, fix: p.fix, mode: 'foot', segs: [[v[0], v[1], n]], heading: 0, claim: planeStep(p, [[v[0], v[1], n]]) }
      }
      sent[k].push(msg as InputMessage)
    } else if (kind < 0.6 && sent[k].length > 0) {
      // A near miss of an earlier input: mutated, replayed, or under a correction long gone or never made.
      const old = g.pick(sent[k])
      const r = g.next()
      msg = r < 0.5 ? mutate(old, g, g.int(1, 2)) : r < 0.7 ? old : { ...old, fix: g.pick([0, p.fix - 1, p.fix + 1, p.fix + 100]), seq: ++seqs[k] }
    } else if (kind < 0.7) {
      msg = mutate(g.pick(CLIENT), g, g.int(0, 2))
    } else if (kind < 0.8) {
      msg = { t: 'ack', ack: g.pick([room.tick, room.tick + 1, 0]) }
    } else {
      // A burst: an honest input with as many substeps as an input may carry.
      const seq = ++seqs[k]
      msg = p.driving
        ? { t: 'input', seq, ack: room.tick, fix: p.fix, mode: 'drive', segs: [[1, 0, 0, 0, LIMITS.stepsPerInput]], heading: 0, claim: { x: p.x, y: 0.7, z: p.z } }
        : { t: 'input', seq, ack: room.tick, fix: p.fix, mode: 'foot', segs: [[0, 0, LIMITS.stepsPerInput]], heading: 0, claim: planeStep(p, [[0, 0, LIMITS.stepsPerInput]]) }
    }
    const read = readClientMessage(msg)
    const out = read.ok ? handle(room, p, read.msg, now, verify) : (read.reason.startsWith('input') ? refuseInput(room, p, read.reason, now) : { refused: read.reason })
    log.push([k, out])
    // Invariants after every message.
    assert.ok(p.seq >= before.seq, 'the kept seq only rises')
    assert.ok(p.fix >= before.fix, 'the correction number only rises')
    const kept = p.seq !== before.seq
    if (!kept && !out.reply) assert.deepEqual([p.x, p.y, p.z, p.driving], [before.x, before.y, before.z, before.driving], 'the truth moves only when an input is kept or corrected')
    if (out.reply?.t === 'correct') {
      assert.equal(out.reply.fix, p.fix, 'a correction carries the new number')
      assert.equal(out.reply.ack, p.seq, 'and the newest input kept')
    }
    if (kept && read.ok && read.msg.t === 'input') {
      keptSteps[k] += read.msg.segs.reduce((a, r) => a + r[r.length - 1], 0)
      if (read.msg.door) keptDoors[k]++
    }
    const elapsed = (now - start) / 1000
    assert.ok(keptSteps[k] <= LIMITS.stepBurst + LIMITS.stepsPerSecond * LIMITS.headroom * elapsed + 1e-9, `substeps kept ${keptSteps[k]} in ${elapsed.toFixed(2)} s`)
    assert.ok(keptDoors[k] <= LIMITS.doorBurst + LIMITS.doorsPerSecond * elapsed + 1e-9, `doors kept ${keptDoors[k]} in ${elapsed.toFixed(2)} s`)
    if (out.kick) {
      assert.ok(p.refusals >= LIMITS.refusalsBeforeKick || out.kick === 'repeated illegal movement', out.kick)
      room.peers.delete(p.id)
    }
  }
  return { room, peers, log }
}

test('the room keeps its invariants under 400 adversarial sessions on a chaotic clock, and two rooms fed one stream agree', () => {
  forAll('room', { seed: 0xa11ce, runs: 400 }, (g) => ({ seed: g.int(0, 2 ** 31), peers: g.int(1, 4), messages: g.int(50, 400) }), (c) => {
    const one = session(gen(c.seed), c.peers, c.messages)
    const two = session(gen(c.seed), c.peers, c.messages)
    assert.equal(JSON.stringify(one.log), JSON.stringify(two.log), 'deterministic')
  })
})

test('an honest page on a chaotic clock: every input kept through jitter and stalls of up to 2.5 s, and the bank comes back', () => {
  forAll('honest', { seed: 0x40e57, runs: 60 }, (g) => ({ seed: g.int(0, 2 ** 31), seconds: g.int(60, 240) }), (c) => {
    const g = gen(c.seed)
    const room = createRoom(planeAuthority('plane'), 20)
    const p = admit(room, 0)!
    handle(room, p, { t: 'join', v: PROTOCOL_VERSION, token: GOOD, name: 'Ada', world: 'plane' }, 0, verify)
    // The page steps at 60 Hz, one input a substep, its claim its own prediction (the plane replays exactly this). The
    // link delivers in order, as TCP does: each input after a jittered latency, now and then (never twice within
    // 60 s) after a stall of up to 2.5 s, when everything held arrives at once.
    let pred = { x: p.x, z: p.z }
    let seq = 0, due = 0, lastStall = -Infinity, stalls = 0
    const link: { at: number; msg: InputMessage }[] = []
    for (let f = 0; f < c.seconds * 60; f++) {
      const now = (f * 1000) / 60
      const v = [g.float(-RUN, RUN), g.float(-RUN, RUN)]
      const claim = planeStep(pred, [[v[0], v[1], 1]])
      pred = { x: claim.x, z: claim.z }
      let latency = g.float(5, 150)
      if (now - lastStall >= 60_000 && g.bool(0.002)) {
        latency = g.float(1000, 2500)
        lastStall = now
        stalls++
      }
      due = Math.max(due, now + latency)
      link.push({ at: due, msg: { t: 'input', seq: ++seq, ack: room.tick, fix: p.fix, mode: 'foot', segs: [[v[0], v[1], 1]], heading: 0, claim } })
      while (link.length > 0 && link[0].at <= now) {
        const h = link.shift()!
        assert.deepEqual(handle(room, p, h.msg, now, verify), {}, `input ${h.msg.seq} at ${(now / 1000).toFixed(2)} s`)
      }
    }
    for (const h of link) assert.deepEqual(handle(room, p, h.msg, h.at, verify), {})
    assert.equal(p.corrections, 0)
    assert.equal(p.seq, seq)
    assert.ok(stalls <= Math.ceil(c.seconds / 60) + 1)
  })
})

test('adversarial numbers in a claim never move the truth: the room keeps its own replay, not the claimed floats', () => {
  forAll('claims', { seed: 0xf10a7, runs: 3000 }, (g) => ({ v: [g.float(-RUN, RUN), g.float(-RUN, RUN)], n: g.int(0, 30), nudge: nastyNumber(g, 0) }), (c) => {
    const room = createRoom(planeAuthority('plane'), 20)
    const p = admit(room, 0)!
    handle(room, p, { t: 'join', v: PROTOCOL_VERSION, token: GOOD, name: 'Ada', world: 'plane' }, 0, verify)
    const honest = planeStep(p, [[c.v[0], c.v[1], c.n]])
    const claim = { ...honest, x: honest.x + c.nudge }
    const read = readClientMessage({ t: 'input', seq: 1, ack: 0, fix: 1, mode: 'foot', segs: [[c.v[0], c.v[1], c.n]], heading: 0, claim })
    if (!read.ok) return
    const out = handle(room, p, read.msg, 10_000, verify)
    // Kept or corrected, the truth is the room's own: the honest replay, or where it was.
    if (p.seq === 1) assert.deepEqual([p.x, p.z], [honest.x, honest.z], 'kept: the replay, whatever the claim said within the tolerance')
    else assert.equal(out.reply?.t, 'correct')
  })
})
