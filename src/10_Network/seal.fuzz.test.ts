// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the property-based fuzzing of the envelope seal both sides of the wire check
 * (replication.ts sealMessage, readEnvelope, sealFault, openClientFrame, openServerFrame), of the canonical text the
 * seal is computed over (02_Define_The_Rules/integrity.ts canonical) and of the RFC 6455 frame reader and writer the
 * host runs every byte through (replication.node.ts readFrame, writeFrame, closePayload), seeded and replayable
 * (02_Define_The_Rules/property.ts). The properties: canonical() is pure, order-independent and stable (keys sorted at
 * every depth, arrays in order, strings as JSON.stringify writes them, canonical(parse(canonical(x))) == canonical(x))
 * and agrees with an independent reference over tens of thousands of plain values (unicode, numbers at their limits,
 * keys like __proto__), and refuses anything else; a frame sealed over any plain body opens untouched under its key
 * and the envelope number before it, and never under another key, past its bound, or at a number that does not rise
 * (a replay, the number before, 2^53, 1.5, -0, a string); every single-character change of a real frame's wire text,
 * at every position, is refused unless it leaves the JSON value itself unchanged (whitespace), and a refusal moves
 * nothing; readFrame never throws on any bytes, keeps every header rule at every length boundary (the 7-, 16- and
 * 64-bit modes, lengths past the bound and past the buffer, the mask bit both ways, control frames) against a spec
 * written here independently, and reads back what writeFrame writes; and the digests and canonical texts pinned in
 * the OS runtime's Rust mirror (crimson_noir_os/src/wire.rs tests) are the ones node:crypto and integrity.ts compute,
 * so a frame sealed on one side opens on the other. One test is the regression test for a Phase 16 audit finding
 * (canonical of a sparse array) and fails until it is fixed; it is marked.
 * What breaks if it is removed? A body shape, a wire mutation or a frame header nobody tried could slip a forged or
 * replayed frame past the seal, or crash the reader; a drift between the Rust and the TypeScript seal would show only
 * as a bridge that cannot speak.
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { canonical, hmacSha256 } from '../02_Define_The_Rules/integrity.ts'
import { anyValue, forAll, gen, type Gen } from '../02_Define_The_Rules/property.ts'
import { closePayload, nodeMac, OP, readFrame, writeFrame, type FrameRead } from './replication.node.ts'
import {
  LIMITS, openClientFrame, openServerFrame, PROTOCOL_VERSION, readEnvelope, sealFault, sealMessage,
  type ClientMessage, type Peer, type ServerMessage,
} from './replication.ts'

// ---------------------------------------------------------------- plain values

const STRINGS = ['', 'x', 'input', '"', '\\', '\n', '\r\t\b\f', '\u0000', '\u001f', '\u007f', '  ', 'é', '日本語', '😀', '\ud800', '\udc00x', 'à', ' ', 'auth.', '{"n":1}', '</script>', 'a'.repeat(300)]
const NUMBERS = [0, -0, 1, -1, 0.5, 0.1 + 0.2, 2 ** 53 - 1, 2 ** 53, 2 ** 53 + 2, -(2 ** 53), 1e21, -1e21, 1e-7, 1e-308, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, 2 ** 31, 2 ** 32, 4096.000001, 1e16, 123456789012345680000, 5e-324]
const KEYS = ['', 'a', 'b', 'n', 'body', 'mac', 't', '__proto__', 'constructor', 'toJSON', 'hasOwnProperty', 'valueOf', '10', '2', '-1', '1.5', 'é', '日', '😀', 'A', 'Z', 'a b', '"', '\n', '\u0000', 'aa', 'ab']

const randomString = (g: Gen): string => Array.from({ length: g.int(0, 12) }, () => String.fromCharCode(g.bool(0.2) ? g.int(0, 0xffff) : g.int(32, 126))).join('')

/** A plain value (dense arrays, finite numbers, undefined only where JSON.stringify would drop or null it). */
function plain(g: Gen, depth = 3): unknown {
  switch (g.int(0, depth > 0 ? 7 : 4)) {
    case 0: return null
    case 1: return g.bool()
    case 2: return g.pick(NUMBERS)
    case 3: return g.bool(0.3) ? g.float(-1e6, 1e6) : g.int(-1e9, 1e9)
    case 4: return g.bool(0.3) ? randomString(g) : g.pick(STRINGS)
    case 5: return Array.from({ length: g.int(0, 5) }, () => (g.bool(0.05) ? undefined : plain(g, depth - 1)))
    default: {
      // Object.fromEntries defines own properties, so a '__proto__' key is a key, not a prototype.
      const entries: [string, unknown][] = Array.from({ length: g.int(0, 6) }, () => [g.bool(0.2) ? randomString(g) : g.pick(KEYS), g.bool(0.05) ? undefined : plain(g, depth - 1)])
      return Object.fromEntries(entries)
    }
  }
}

/** An independent reference for canonical(): the contract in integrity.ts, written again from the comment. */
function reference(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('reference: not finite')
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) return `[${Array.from(v, (x) => reference(x === undefined ? null : x)).join(',')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    const proto = Object.getPrototypeOf(o)
    if (proto !== null && proto !== Object.prototype) throw new TypeError('reference: not plain')
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${reference(o[k])}`).join(',')}}`
  }
  throw new TypeError('reference: not plain')
}

/** The same value with every object's keys in another insertion order (and arrays untouched). */
function reordered(v: unknown, g: Gen): unknown {
  if (Array.isArray(v)) return v.map((x) => reordered(x, g))
  if (typeof v === 'object' && v !== null) {
    const entries = Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, reordered(x, g)] as [string, unknown])
    for (let i = entries.length - 1; i > 0; i--) {
      const j = g.int(0, i)
      ;[entries[i], entries[j]] = [entries[j], entries[i]]
    }
    return Object.fromEntries(entries)
  }
  return v
}

test('canonical is pure, order-independent and stable, and agrees with an independent reference over 20,000 plain values', () => {
  forAll('canonical', { seed: 0xca40, runs: 20_000 }, (g) => plain(g), (x, i) => {
    const text = canonical(x)
    assert.equal(text, reference(x), 'the reference')
    assert.equal(canonical(x), text, 'pure')
    const parsed: unknown = JSON.parse(text)
    assert.equal(canonical(parsed), text, 'canonical(parse(canonical(x))) == canonical(x)')
    assert.equal(canonical(JSON.parse(JSON.stringify(x))), text, 'the same value JSON.stringify sees (undefined dropped, -0 as 0)')
    assert.equal(canonical(reordered(x, gen(i))), text, 'order-independent')
    assert.ok(!/\s/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""')), 'no whitespace outside strings')
    if (typeof x === 'string') assert.equal(text, JSON.stringify(x), 'strings as JSON.stringify writes them')
  })
})

test('canonical refuses what is not plain data, and takes a null-prototype object as plain', () => {
  for (const u of [Number.NaN, Infinity, -Infinity, undefined, 1n, (): number => 0, new Date(0), new Map(), new Set(), Object.create({}), Symbol('s'), new Uint8Array(2), /x/, new (class A {})()]) {
    assert.throws(() => canonical(u), TypeError, String(typeof u))
  }
  for (const nested of [{ a: Number.NaN }, [1, [2, [Infinity]]], { a: { b: new Date(0) } }, [undefined, 1n]]) assert.throws(() => canonical(nested), TypeError)
  assert.equal(canonical(Object.create(null)), '{}')
  const o = Object.create(null) as Record<string, unknown>
  o.b = 1
  o.a = [1, undefined, null]
  assert.equal(canonical(o), '{"a":[1,null,null],"b":1}')
})

test('REGRESSION (Phase 16 audit, canonical of a sparse array): a hole is written as null, as the comment promises and JSON.stringify does, so the text is JSON', () => {
  // Finding: `value.map` skips holes, so canonical([ , 1]) is "[,1]": not JSON (opened() throws on it) and not what
  // JSON.stringify writes ("[null,1]"), so a seal over such a value verifies but cannot be opened, and a sealMessage
  // over it is refused by every receiver. Fix: Array.from(value, ...) or a plain loop. Fails until then.
  const holes = new Array<unknown>(3)
  holes[1] = 1
  assert.equal(canonical(holes), JSON.stringify(holes))
  assert.deepEqual(JSON.parse(canonical(holes)), [null, 1, null])
  assert.equal(canonical({ xs: new Array<unknown>(2) }), '{"xs":[null,null]}')
  assert.equal(canonical(holes), reference(holes))
})

// ---------------------------------------------------------------- the seal over random bodies

const KEY_CHARS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.', 'é', '日', '😀', ' ']
/** Whether two JSON texts carry the same value (so a change in whitespace, or -0 for 0, is no change). */
const sameValue = (a: string, b: string): boolean => JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b))
const key = (g: Gen): string => Array.from({ length: g.int(1, 120) }, () => g.pick(KEY_CHARS)).join('')
const asRecord = (g: Gen): Record<string, unknown> => {
  const v = plain(g)
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : { v }
}

test('a frame sealed over any plain body opens untouched under its key after the number before it, and never under another key, past its bound, or at a number that does not rise', () => {
  forAll('seal', { seed: 0x5ea1ed, runs: 4000 }, (g) => ({ body: asRecord(g), n: g.bool(0.1) ? g.pick([1, 2, LIMITS.maxSeq - 1, 2 ** 31, 2 ** 32]) : g.int(1, 10 ** 6), k: key(g), other: key(g) }), ({ body, n, k, other }) => {
    const msg = body as unknown as ClientMessage
    const wire = sealMessage(msg, n, k, nodeMac)
    assert.equal(wire, sealMessage(msg, n, k), 'node:crypto and integrity.ts seal alike')
    const env = readEnvelope(wire, Infinity)
    assert.ok(env.ok, 'the envelope')
    assert.equal(env.msg.n, n)
    assert.deepEqual(env.msg.body, JSON.parse(JSON.stringify(body)))
    assert.ok(Object.isFrozen(env.msg))
    assert.equal(sealFault(env.msg, k, n - 1), null, 'the number before it')
    assert.equal(sealFault(env.msg, k, 0, nodeMac), null)
    assert.equal(sealFault(env.msg, k, n), 'envelope: replayed', 'a replay')
    assert.equal(sealFault(env.msg, k, n + 1), 'envelope: replayed', 'behind')
    assert.equal(sealFault(env.msg, k, LIMITS.maxSeq), 'envelope: replayed')
    if (other !== k) assert.equal(sealFault(env.msg, other, n - 1), 'envelope: bad seal', 'another key')
    assert.equal(sealFault({ ...env.msg, n: n + 1 }, k, n - 1), 'envelope: bad seal', 'the number is sealed too')
    // The bound: a client's frame at LIMITS.message, the host's at hostMessage, in characters of the wire.
    const bounded = readEnvelope(wire)
    assert.equal(bounded.ok, wire.length <= LIMITS.message, 'within the client bound')
    if (!bounded.ok) assert.equal(bounded.reason, `message longer than ${LIMITS.message}`)
    assert.equal(readEnvelope(wire, wire.length).ok, true)
    assert.equal(readEnvelope(wire, wire.length - 1).ok, false)
  })
})

test('numbers that do not rise, and numbers that are not envelope numbers: n = after, after - 1, 2^53, 2^40, 1.5, -0, -1, a string, null', () => {
  const k = 'the-session-token'
  const msg = { t: 'ack', ack: 3 } as ClientMessage
  for (const n of [-1, 1.5, 2 ** 40, 2 ** 53, Number.NaN, Infinity, -Infinity, 0.1]) assert.throws(() => sealMessage(msg, n, k), RangeError, `sealMessage(n = ${n})`)
  const good = sealMessage(msg, 5, k)
  const withN = (spelled: string): string => good.replace('"n":5', `"n":${spelled}`)
  assert.notEqual(withN('6'), good)
  for (const [spelled, reason] of [['6', 'envelope: bad seal'], ['4', 'envelope: bad seal'], ['9007199254740992', 'envelope: n'], ['1099511627776', 'envelope: n'], ['1.5', 'envelope: n'], ['-1', 'envelope: n'], ['"5"', 'envelope: n'], ['null', 'envelope: n'], ['true', 'envelope: n'], ['[5]', 'envelope: n'], ['1e3', 'envelope: bad seal'], ['5.0', 'envelope: replayed']]) {
    const p = { joined: true, key: k, received: 5 } as unknown as Peer
    const r = openClientFrame(p, withN(spelled))
    assert.ok(!r.ok, `n spelled ${spelled} accepted`)
    assert.equal(r.reason, reason, `n spelled ${spelled}`)
    assert.equal(p.received, 5, 'a refusal moves nothing')
  }
  // -0 is a safe integer at or above zero to count(), so the envelope reads; it is then below every number a peer has
  // received (0 at the start), so it is never the next frame. Pinned as the property, not the reading.
  const zero = sealMessage(msg, 0, k)
  assert.ok(zero.includes('"n":0'))
  for (const wire of [zero, zero.replace('"n":0', '"n":-0')]) {
    const p = { joined: true, key: k, received: 0 } as unknown as Peer
    assert.ok(!openClientFrame(p, wire).ok, `an envelope numbered ${wire.slice(0, 8)} is never the first`)
    assert.equal(p.received, 0)
    assert.ok(!openServerFrame(wire, k, 0).ok)
  }
  // The number must rise by any amount, not by one.
  const p = { joined: true, key: k, received: 5 } as unknown as Peer
  assert.ok(openClientFrame(p, sealMessage(msg, 1000, k)).ok)
  assert.equal(p.received, 1000)
  assert.ok(!openClientFrame(p, sealMessage(msg, 999, k)).ok)
  assert.ok(openClientFrame(p, sealMessage(msg, LIMITS.maxSeq - 1, k)).ok)
})

test('readEnvelope never throws and accepts only the shape: random text, random JSON values, wrong types, prototype keys', () => {
  forAll('envelope', { seed: 0xe4e, runs: 20_000 }, (g): { wire: unknown; sealed: string | null } => {
    switch (g.int(0, 4)) {
      case 0: return { wire: Array.from({ length: g.int(0, 80) }, () => String.fromCharCode(g.int(0, 0x7f))).join(''), sealed: null }
      case 1: return { wire: JSON.stringify(anyValue(g)) ?? 'undefined', sealed: null }
      case 2: return { wire: JSON.stringify({ n: anyValue(g, 1), body: anyValue(g, 1), mac: anyValue(g, 1) }, (_k, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)), sealed: null }
      case 3: return { wire: g.pick([null, undefined, 42, {}, [], Buffer.from('{"n":1}'), Symbol.for('x'), 1n, true, () => 'x']), sealed: null }
      default: {
        // A frame sealed under 'k', one character changed (which may leave the value as it was: a space, or the same character).
        const sealed = sealMessage({ t: 'ack', ack: g.int(0, 9) } as ClientMessage, g.int(1, 99), 'k')
        const i = g.int(0, sealed.length - 1)
        return { wire: `${sealed.slice(0, i)}${String.fromCharCode(g.int(0, 0x7f))}${sealed.slice(i + 1)}`, sealed }
      }
    }
  }, ({ wire, sealed }) => {
    const r = readEnvelope(wire)
    if (!r.ok) {
      assert.equal(typeof r.reason, 'string')
      return
    }
    assert.ok(Number.isSafeInteger(r.msg.n) && r.msg.n >= 0 && r.msg.n < LIMITS.maxSeq)
    assert.match(r.msg.mac, /^[0-9a-f]{64}$/)
    assert.ok(typeof r.msg.body === 'object' && r.msg.body !== null && !Array.isArray(r.msg.body))
    assert.ok(typeof wire === 'string' && wire.length <= LIMITS.message)
    // Whatever it reads, the seal is still judged on the text's own value: it holds only for the frame sealed under
    // 'k' with its value untouched, and a wrong one is refused, never thrown on.
    const fault = sealFault(r.msg, 'k', 0)
    if (fault === null) assert.ok(sealed !== null && typeof wire === 'string' && sameValue(wire, sealed), `a seal held on ${String(wire)}`)
    else assert.equal(typeof fault, 'string')
  })
  assert.deepEqual(readEnvelope('{"n":1,"body":{"__proto__":{"t":"ack","ack":1}},"mac":"' + '0'.repeat(64) + '"}'), { ok: true, msg: { n: 1, body: { ['__proto__']: { t: 'ack', ack: 1 } }, mac: '0'.repeat(64) } })
  assert.equal(readEnvelope('{"n":1,"body":{},"mac":"' + '0'.repeat(63) + 'A"}').ok, false, 'a mac in upper case is no digest')
})

// ---------------------------------------------------------------- mutations of real frames

const STATE = { x: 101.5, y: 0.56, z: 202.25, qx: 0, qy: 0.6, qz: 0, qw: 0.8, vx: 3, vy: -0.01, vz: 4, wx: 0.01, wy: 0.2, wz: -0.01 }
const player = (id: number, o: Record<string, unknown> = {}) => ({ id, name: `p${id}`, x: 1, y: 0.92, z: 2, heading: 0.1, vx: 1, vz: 0, speed: 1, driving: false, ...o })
const KEY = 'QWRh.1000.c2lnbmF0dXJl-signature_of_the_session'
const CLIENT: readonly ClientMessage[] = [
  { t: 'join', v: PROTOCOL_VERSION, token: KEY, name: 'Ada', world: 'city/1337/36' },
  { t: 'input', seq: 3, ack: 2, fix: 1, mode: 'foot', segs: [[1, -1, 2], [0, 0.5, 3]], heading: 0.5, claim: { x: 1, y: 0.92, z: -1 } },
  { t: 'input', seq: 5, ack: 2, fix: 1, mode: 'drive', segs: [[0, 0, 0, 0, 0]], heading: 1, claim: { x: 101.5, y: 0.56, z: 202.25 }, door: { enter: { car: 7, state: STATE } } },
  { t: 'ack', ack: 9 },
  { t: 'chat', seq: 1, text: 'Could you bring the forms? ☕ "quoted" \\ back' },
  { t: 'ping', seq: 2, kind: 'gather', x: 1, y: 2, z: 3 },
  { t: 'leave' },
] as ClientMessage[]
const SERVER: readonly ServerMessage[] = [
  { t: 'welcome', v: PROTOCOL_VERSION, id: 1, tick: 3, tickHz: 20, fix: 1, you: player(1), players: [player(2), player(3, { driving: true, vx: 30, speed: 30 })] },
  { t: 'snapshot', tick: 4, ack: 3, fix: 1, you: player(1), players: [player(2)] },
  { t: 'correct', fix: 3, ack: 3, you: player(1, { x: STATE.x, y: STATE.y, z: STATE.z, driving: true }), reason: 'chassis', tick: 4, car: { index: 7, state: STATE } },
  { t: 'chat', from: 2, name: 'Bob', text: 'hello', tick: 5 },
  { t: 'left', id: 4, reason: 'left', tick: 7 },
] as unknown as ServerMessage[]
const MUTATION_CHARS = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), '\u0000', '\n', '\t', 'é', ' ', '😀', '\ud800']

/** Every position of `wire`: one replacement, one deletion, and one insertion at the gap before it (and after the end). */
function* wireMutations(wire: string, g: Gen): Generator<string> {
  for (let i = 0; i < wire.length; i++) {
    const r = g.pick(MUTATION_CHARS)
    if (r !== wire[i]) yield wire.slice(0, i) + r + wire.slice(i + 1)
    yield wire.slice(0, i) + wire.slice(i + 1)
    yield wire.slice(0, i) + g.pick(MUTATION_CHARS) + wire.slice(i)
  }
  yield wire + g.pick(MUTATION_CHARS)
}

test('every single-character mutation of a client frame, at every position, is refused unless the JSON value is untouched; a refusal moves nothing', () => {
  forAll('client mutations', { seed: 0xc11e47, runs: 240 }, (g, i) => ({ msg: g.pick(CLIENT), n: g.int(1, 5000), seed: i }), ({ msg, n, seed }) => {
    const g = gen(seed)
    const wire = sealMessage(msg, n, KEY, nodeMac)
    const peer = (received: number): Peer => ({ joined: msg.t !== 'join', key: msg.t === 'join' ? '' : KEY, received } as unknown as Peer)
    const p = peer(n - 1)
    assert.ok(openClientFrame(p, wire, nodeMac).ok, 'untouched')
    assert.equal(p.received, n)
    let accepted = 0, refused = 0
    for (const m of wireMutations(wire, g)) {
      const q = peer(n - 1)
      const r = openClientFrame(q, m, nodeMac)
      if (r.ok) {
        accepted++
        assert.ok(sameValue(m, wire), `a mutation with another value was accepted: ${m}`)
        assert.equal(q.received, n)
      } else {
        refused++
        assert.equal(q.received, n - 1, 'a refusal moves nothing')
      }
    }
    assert.ok(refused > 3 * wire.length - 40, `nearly every mutation refused (${refused} of ${accepted + refused})`)
  })
})

test('every single-character mutation of a host frame, at every position, is refused on the page unless the JSON value is untouched', () => {
  forAll('host mutations', { seed: 0x5e4e4, runs: 60 }, (g, i) => ({ msg: g.pick(SERVER), n: g.int(1, 5000), seed: i }), ({ msg, n, seed }) => {
    const g = gen(seed)
    const wire = sealMessage(msg, n, KEY, nodeMac)
    const opened = openServerFrame(wire, KEY, n - 1)
    assert.ok(opened.ok, 'untouched')
    assert.equal(opened.n, n)
    assert.ok(!openServerFrame(wire, KEY, n).ok, 'once')
    assert.ok(!openServerFrame(wire, `${KEY}x`, n - 1).ok, 'another key')
    for (const m of wireMutations(wire, g)) {
      if (openServerFrame(m, KEY, n - 1).ok) assert.ok(sameValue(m, wire), `a mutation with another value was accepted: ${m}`)
    }
    // Every hex digit of the seal, changed to every other, is refused; so is any upper-case spelling.
    const env = readEnvelope(wire, LIMITS.hostMessage)
    assert.ok(env.ok)
    const at = g.int(0, 63)
    for (const d of '0123456789abcdefABCDEF') {
      if (d === env.msg.mac[at]) continue
      assert.equal(sealFault({ ...env.msg, mac: env.msg.mac.slice(0, at) + d + env.msg.mac.slice(at + 1) }, KEY, n - 1), 'envelope: bad seal')
    }
    assert.ok(!openServerFrame(wire.replace(env.msg.mac, env.msg.mac.toUpperCase()), KEY, n - 1).ok, 'upper case')
  })
})

// ---------------------------------------------------------------- frames

interface Header { fin: boolean; rsv: number; opcode: number; masked: boolean; mode: 7 | 16 | 64; len: bigint; avail: 'header-1' | 'header' | 'partial' | 'whole' | 'extra'; max: number }

const VALID_OPCODES: readonly number[] = [OP.text, OP.binary, OP.close, OP.ping, OP.pong]
const MAXES = [LIMITS.message, 16384, 125, 65535, 70_000]

/** `n` payload bytes: a seeded stride pattern (every byte value, no two frames alike) with a few bytes set at random, cheap at 70 KB. */
function bytes(n: number, g: Gen): Buffer {
  const b = Buffer.alloc(n)
  const start = g.int(0, 255), stride = g.int(1, 255)
  for (let i = 0; i < n; i++) b[i] = (start + i * stride) & 0xff
  for (let k = Math.min(n, 8); k > 0; k--) b[g.int(0, n - 1)] = g.int(0, 255)
  return b
}

function header(g: Gen): Header {
  const mode = g.pick([7, 16, 64] as const)
  const len = mode === 7 ? BigInt(g.pick([0, 1, 2, 124, 125, g.int(0, 125)]))
    : mode === 16 ? BigInt(g.pick([126, 127, 128, 4095, 4096, 4097, 16384, 16385, 65535, g.int(126, 65535)]))
    : g.pick([65536n, 65537n, 70_000n, 70_001n, 2n ** 31n, 2n ** 32n, 2n ** 53n - 1n, 2n ** 53n, 2n ** 63n - 1n, 2n ** 63n, 2n ** 64n - 1n])
  const buildable = len <= 70_000n
  return {
    fin: g.bool(0.85), rsv: g.bool(0.85) ? 0 : g.int(1, 7), opcode: g.bool(0.85) ? g.pick(VALID_OPCODES) : g.pick([0, 3, 7, 11, 15]),
    masked: g.bool(0.85), mode, len, avail: buildable ? g.pick(['header-1', 'header', 'partial', 'whole', 'extra'] as const) : g.pick(['header-1', 'header'] as const), max: g.pick(MAXES),
  }
}

/** The bytes of `h`, as far as `avail` says, and the payload they carry (the client's, before masking). */
function build(h: Header, g: Gen): { buf: Buffer; payload: Buffer; headerLen: number } {
  const b0 = (h.fin ? 0x80 : 0) | (h.rsv << 4) | h.opcode
  const m = h.masked ? 0x80 : 0
  let head: Buffer
  if (h.mode === 7) head = Buffer.from([b0, m | Number(h.len)])
  else if (h.mode === 16) {
    head = Buffer.from([b0, m | 126, 0, 0])
    head.writeUInt16BE(Number(h.len), 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = b0
    head[1] = m | 127
    head.writeBigUInt64BE(h.len, 2)
  }
  const n = h.len <= 70_000n ? Number(h.len) : 0
  const payload = bytes(n, g)
  const mask = Buffer.from([g.int(0, 255), g.int(0, 255), g.int(0, 255), g.int(0, 255)])
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]))
  const whole = Buffer.concat([head, mask, masked])
  const buf = h.avail === 'header-1' ? head.subarray(0, head.length - 1)
    : h.avail === 'header' ? head
    : h.avail === 'partial' ? whole.subarray(0, head.length + (n > 0 ? 4 + g.int(0, n - 1) : g.int(0, 3)))
    : h.avail === 'whole' ? whole
    : Buffer.concat([whole, Buffer.from([g.int(0, 255), g.int(0, 255), g.int(0, 255)])])
  return { buf, payload, headerLen: head.length }
}

/** What the rules in readFrame's comment say of `h` seen through `buf`, written without looking at the reader. */
function expected(h: Header, buf: Buffer, headerLen: number): { kind: 'more' } | { kind: 'bad'; code: number; faults: number } | { kind: 'frame'; used: number } {
  if (buf.length < 2) return { kind: 'more' }
  const faults = [h.rsv !== 0, !h.fin || h.opcode === OP.continuation, !VALID_OPCODES.includes(h.opcode) && h.opcode !== OP.continuation, !h.masked].filter(Boolean).length
  if (h.rsv !== 0) return { kind: 'bad', code: 1002, faults }
  if (!h.fin || h.opcode === OP.continuation) return { kind: 'bad', code: 1003, faults }
  if (!VALID_OPCODES.includes(h.opcode)) return { kind: 'bad', code: 1002, faults }
  if (!h.masked) return { kind: 'bad', code: 1002, faults }
  if (buf.length < headerLen) return { kind: 'more' }
  const tooBig = h.len > BigInt(h.max), control = h.opcode >= OP.close && h.len > 125n
  if (tooBig) return { kind: 'bad', code: 1009, faults: (control ? 1 : 0) + 1 }
  if (control) return { kind: 'bad', code: 1002, faults: 1 }
  const used = headerLen + 4 + Number(h.len)
  return buf.length < used ? { kind: 'more' } : { kind: 'frame', used }
}

test('readFrame keeps every header rule at every length boundary: the three length modes, the bound, the buffer, the mask bit, control frames, against a spec written here', () => {
  forAll('headers', { seed: 0xf4a3e, runs: 16_000 }, (g) => {
    const h = header(g)
    return { h, ...build(h, g) }
  }, ({ h, buf, payload, headerLen }) => {
    const want = expected(h, buf, headerLen)
    const got: FrameRead = readFrame(buf, h.max)
    assert.equal(got.kind, want.kind, `${JSON.stringify({ ...h, len: String(h.len) })} on ${buf.length} bytes: ${JSON.stringify(got)}`)
    if (want.kind === 'bad' && got.kind === 'bad') {
      // One rule broken names its code; several at once are a close either way.
      if (want.faults === 1) assert.equal(got.code, want.code, `${JSON.stringify({ ...h, len: String(h.len) })}: ${got.reason}`)
      assert.ok([1002, 1003, 1009].includes(got.code))
    }
    if (want.kind === 'frame' && got.kind === 'frame') {
      assert.equal(got.used, want.used)
      assert.equal(got.opcode, h.opcode)
      assert.ok(got.payload.equals(payload), 'the payload unmasked')
    }
  })
})

test('readFrame never throws on any bytes, and whatever it reads is within the bound and whole', () => {
  const okBad = [1002, 1003, 1009]
  forAll('bytes', { seed: 0xb17e5, runs: 30_000 }, (g) => {
    const max = g.pick([0, 1, 125, 126, 4096, 16384, 65536, 2 ** 31])
    let buf: Buffer
    const roll = g.next()
    if (roll < 0.5) buf = Buffer.from(Array.from({ length: g.int(0, 80) }, () => g.int(0, 255)))
    else {
      // A good masked frame, then damaged: bytes changed, truncated, or more bytes behind it.
      const h: Header = { fin: true, rsv: 0, opcode: g.pick(VALID_OPCODES), masked: true, mode: 7, len: BigInt(g.int(0, 60)), avail: 'whole', max }
      buf = Buffer.from(build(h, g).buf)
      for (let k = g.int(0, 3); k > 0; k--) buf[g.int(0, buf.length - 1)] = g.int(0, 255)
      if (g.bool(0.3)) buf = buf.subarray(0, g.int(0, buf.length))
      if (g.bool(0.3)) buf = Buffer.concat([buf, Buffer.from(Array.from({ length: g.int(1, 20) }, () => g.int(0, 255)))])
    }
    return { buf, max }
  }, ({ buf, max }) => {
    const r = readFrame(buf, max)
    if (r.kind === 'bad') assert.ok(okBad.includes(r.code) && typeof r.reason === 'string')
    else if (r.kind === 'frame') {
      assert.ok(r.used <= buf.length && r.used >= 6)
      assert.ok(r.payload.length <= max && r.payload.length <= r.used - 6)
      assert.ok(VALID_OPCODES.includes(r.opcode))
      if (r.opcode >= OP.close) assert.ok(r.payload.length <= 125)
    } else assert.equal(r.kind, 'more')
  })
  assert.deepEqual(readFrame(Buffer.alloc(0)), { kind: 'more' })
  assert.deepEqual(readFrame(Buffer.from([0x81])), { kind: 'more' })
})

/** A host frame as a client would have sent it: the mask bit set, a mask key, the payload masked. */
function masked(frame: Buffer, g: Gen): Buffer {
  const headerLen = (frame[1] & 0x7f) === 126 ? 4 : (frame[1] & 0x7f) === 127 ? 10 : 2
  const mask = Buffer.from([g.int(0, 255), g.int(0, 255), g.int(0, 255), g.int(0, 255)])
  const head = Buffer.from(frame.subarray(0, headerLen))
  head[1] |= 0x80
  return Buffer.concat([head, mask, Buffer.from(frame.subarray(headerLen).map((b, i) => b ^ mask[i & 3]))])
}

test('writeFrame writes the minimal header, FIN set, unmasked; masked as a client would, readFrame reads it back whole; closePayload is a code and at most 123 bytes of reason', () => {
  forAll('round trip', { seed: 0x3017, runs: 1500 }, (g) => {
    const opcode = g.pick(VALID_OPCODES)
    const len = opcode >= OP.close ? g.pick([0, 1, 2, 125, g.int(0, 125)]) : g.pick([0, 1, 125, 126, 127, 4096, 65535, 65536, 70_000, g.int(0, 2000)])
    return { opcode, payload: bytes(len, g), seed: g.int(0, 2 ** 31) }
  }, ({ opcode, payload, seed }) => {
    const g = gen(seed)
    const f = writeFrame(opcode, payload)
    assert.equal(f[0], 0x80 | opcode, 'FIN, no reserved bits, the opcode')
    assert.equal(f[1] & 0x80, 0, 'unmasked')
    const n = payload.length
    if (n < 126) assert.equal(f.length, 2 + n)
    else if (n < 65536) {
      assert.equal(f[1], 126)
      assert.equal(f.readUInt16BE(2), n)
      assert.equal(f.length, 4 + n)
    } else {
      assert.equal(f[1], 127)
      assert.equal(f.readBigUInt64BE(2), BigInt(n))
      assert.equal(f.length, 10 + n)
    }
    assert.ok(f.subarray(f.length - n).equals(payload))
    const m = masked(f, g)
    const r = readFrame(m, 70_000)
    assert.equal(r.kind, 'frame')
    if (r.kind !== 'frame') return
    assert.equal(r.opcode, opcode)
    assert.ok(r.payload.equals(payload))
    assert.equal(r.used, m.length)
    const trailing = readFrame(Buffer.concat([m, Buffer.from([0x81, 0x80])]), 70_000)
    assert.ok(trailing.kind === 'frame' && trailing.used === m.length, 'what follows is left for the next read')
    assert.deepEqual(readFrame(f, 70_000), { kind: 'bad', code: 1002, reason: 'unmasked client frame' }, 'the host\'s own frame is no client frame')
    if (n > LIMITS.message) assert.deepEqual(readFrame(m), { kind: 'bad', code: 1009, reason: 'frame too big' })
  })
  forAll('close payload', { seed: 0xc105e, runs: 500 }, (g) => ({ code: g.int(1000, 4999), reason: Array.from({ length: g.int(0, 200) }, () => g.pick(['a', ' ', 'é', '日', '😀', '"'])).join(''), seed: g.int(0, 2 ** 31) }), ({ code, reason, seed }) => {
    const p = closePayload(code, reason)
    assert.ok(p.length <= 125, 'a control frame\'s payload')
    assert.equal(p.readUInt16BE(0), code)
    assert.ok(p.subarray(2).equals(Buffer.from(reason, 'utf8').subarray(0, 123)))
    assert.equal(readFrame(masked(writeFrame(OP.close, p), gen(seed))).kind, 'frame')
  })
})

// ---------------------------------------------------------------- the Rust mirror (crimson_noir_os/src/wire.rs)

test('the vectors pinned in the OS runtime\'s wire.rs are what node:crypto and integrity.ts compute: HMAC (RFC 4231, the long-key case too), canonical texts, and the sealed {n, body} both sides sign', () => {
  // wire::tests::the_digests_are_the_standards
  const vectors: [Buffer, string, string][] = [
    [Buffer.alloc(20, 0x0b), 'Hi There', 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'],
    [Buffer.alloc(131, 0xaa), 'Test Using Larger Than Block-Size Key - Hash Key First', '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'],
  ]
  for (const [k, m, want] of vectors) {
    assert.equal(hmacSha256(k, m), want, 'integrity.ts')
    assert.equal(createHmac('sha256', k).update(m).digest('hex'), want, 'node:crypto')
  }
  // wire::tests::canonical_json_is_integrity_ts_canonical
  assert.equal(canonical({ n: 3, body: { t: 'hello', v: 1 } }), '{"body":{"t":"hello","v":1},"n":3}')
  assert.equal(canonical('a"b\\c\nd\u0001'), '"a\\"b\\\\c\\nd\\u0001"')
  assert.equal(canonical([-5, null, true]), '[-5,null,true]')
  // The escapes wire.rs quote() writes, one by one, are JSON.stringify's: \b \f \n \r \t, \u00XX below 0x20, DEL and non-ASCII raw.
  assert.equal(canonical('\b\f\n\r\t\u0000\u001f\u007f\u0080é日😀/'), '"\\b\\f\\n\\r\\t\\u0000\\u001f\u007f\u0080é日😀/"')
  // Keys sort by UTF-16 code unit on both sides: a surrogate pair before U+FFFF, upper case before lower, digits first.
  assert.equal(canonical({ '￿': 0, '😀': 1, a: 2, A: 3, '1': 4, '': 5 }), '{"":5,"1":4,"A":3,"a":2,"😀":1,"￿":0}')
  // A Rust Sealed::send wire (canonical {n, body, mac}, keys sorted) opens here; a sealMessage wire's mac is the HMAC
  // Rust recomputes over the canonical {n, body} it parses from the wire.
  const token = 'QWRh.1000.c2lnbmF0dXJl'
  const body = { t: 'weights', list: [[0, 12], [9, -3]], head: '00', count: 3 }
  const mac = hmacSha256(token, canonical({ n: 1, body }))
  const rustWire = canonical({ n: 1, body, mac })
  assert.ok(rustWire.startsWith('{"body":{"count":3,"head":"00","list":[[0,12],[9,-3]],"t":"weights"},"mac":"'))
  const env = readEnvelope(rustWire)
  assert.ok(env.ok)
  assert.equal(sealFault(env.msg, token, 0), null, 'a Rust-sealed frame opens here')
  const tsWire = sealMessage(body as unknown as ClientMessage, 7, token, nodeMac)
  const parsed = JSON.parse(tsWire) as { n: number; body: unknown; mac: string }
  assert.equal(parsed.mac, hmacSha256(token, canonical({ n: parsed.n, body: parsed.body })), 'what Rust recomputes from the parsed wire')
  // node:crypto's HMAC and integrity.ts's agree over random unicode keys and messages, either side of the block size.
  forAll('hmac', { seed: 0x4ac, runs: 600 }, (g) => {
    const len = g.pick([0, 1, 63, 64, 65, 128, g.int(0, 200)])
    return { k: Array.from({ length: len }, () => g.pick(KEY_CHARS)).join(''), m: randomString(g) + g.pick(STRINGS) }
  }, ({ k, m }) => {
    assert.equal(nodeMac(k, m), hmacSha256(k, m))
    assert.equal(nodeMac(k, m), createHmac('sha256', Buffer.from(k, 'utf8')).update(Buffer.from(m, 'utf8')).digest('hex'))
  })
})
