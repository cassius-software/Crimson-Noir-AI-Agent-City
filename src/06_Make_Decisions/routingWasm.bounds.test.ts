// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the boundary audit of the WebAssembly routing core's host (routingWasm.ts) and of
 * the module's C ABI beneath it, seeded and replayable (02_Define_The_Rules/property.ts), on the inputs the parity
 * and fuzz suites do not draw: arena sizes of 0, 1, a fraction, NaN, the infinities, 2^31 and past 2^53; arenas
 * exactly a track's words and one word short; Track objects a caller could hand the host with a non-number length, no
 * pieces, a piece of no length, pieces out of order, a corner with a look-up table of the wrong size, a stop that is
 * not a number; arc lengths, points and hints at every adversarial double (the largest, the smallest, 2^53, ±1e300,
 * a unit in the last place either side of every piece's ends, the non-numbers); word offsets past the arena, past
 * 2^31 and negative, passed straight to the module. The core must refuse without trapping, answer bit for bit what
 * the reference answers (not within 1e-9: identical), answer the same from two instances and from one twice, and
 * neither grow its memory nor leak on the JS heap over ten thousand calls on the largest ring. Two tests are the
 * regression tests of findings of the Phase 16 audit and fail until they are fixed: a header whose piece count makes
 * 42 · pieces + 7 wrap past 2^32 traps the module instead of being refused (native/routing/src/lib.rs track_at and
 * Track::check must bound the count by the words that remain before multiplying), and a grow of the module's memory
 * through the host's own exports leaves the host reading detached views (routingWasm.ts must re-derive its arena and
 * output views when memory.buffer changes).
 * What breaks if it is removed? A size or offset nobody drew could trap the core or read a detached view, and the
 * fleet would drive on an undefined pose.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ADVERSARIAL_NUMBERS, forAll, gen, ulp, type Gen } from '../02_Define_The_Rules/property.ts'
import { LAYOUT, createRoutingCore, trackWords, type RoutingWasm } from './routingWasm.ts'
import {
  buildTrackNetwork, referenceNextStop, referencePoseAt, referenceProjectOnto, referenceSpeedLimitAt, type Arc, type Corner, type Line, type Piece, type Track,
} from './tracks.ts'

const PAGE = 65536
const networks = [buildTrackNetwork(1337), buildTrackNetwork(1337 ^ 7)]
/** Every track the core lays: the car rings and the drone corridors (lines and corners). */
const tracks: Track[] = networks.flatMap((n) => n.tracks.filter((t) => t.kind === 'car' || t.kind === 'drone'))
const cars: Track[] = tracks.filter((t) => t.kind === 'car')
const biggest = tracks.reduce((a, b) => (trackWords(a) >= trackWords(b) ? a : b))

/** The arena as the host sees it: the pages grown onto the end of the module's memory. */
function arenaOf(core: RoutingWasm): Float64Array {
  const e = core.exports
  const base = e.memory.buffer.byteLength - PAGE * Math.ceil((core.arenaWords * 8) / PAGE)
  return new Float64Array(e.memory.buffer, base, core.arenaWords)
}

/** Bit identity, with every NaN one NaN. */
const same = (a: number, b: number): boolean => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b))
function identical(a: number, b: number, what: string): void {
  if (!same(a, b)) assert.fail(`${what}: core ${a}, reference ${b}`)
}

/** Every number as a string that tells −0, NaN and the infinities apart. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'number' ? (Object.is(x, -0) ? '-0' : Number.isFinite(x) ? x : String(x)) : x))

/** The doubles that break arithmetic, and the ones the fuzz suite stops short of. */
const EXTREME: readonly number[] = Object.freeze([
  ...ADVERSARIAL_NUMBERS, 1e300, -1e300, 1e154, -1e154, 1e-154, 2 ** 1023, -(2 ** 1023), 1e16, 1e17, 2 ** 52 + 0.5, 1e100, 2 ** 31 - 1, -(2 ** 31) - 1, 2 ** 32 + 1,
])

/** An arc length at a boundary: a piece's end, the lap, an extreme double, or one of those nudged by an ulp. */
function edgeS(g: Gen, t: Track): number {
  const piece = g.pick(t.pieces)
  const edge = g.pick([piece.s0, piece.s0 + piece.length, 0, t.length, -t.length, 2 * t.length, t.length / 2])
  switch (g.int(0, 5)) {
    case 0: return g.pick(EXTREME)
    case 1: return edge + (g.bool() ? 1 : -1) * ulp(edge)
    case 2: return edge + g.pick([2 ** 53, -(2 ** 53), 2 ** 31, -(2 ** 31), 1e15, -1e15]) * t.length
    case 3: return edge
    case 4: return Math.fround(edge)
    default: return g.pick(EXTREME) * t.length
  }
}

// ---------------------------------------------------------------- the arena

test('an arena of 0, a fraction, a non-number, a negative or an impossible size is refused before anything is instantiated or grown', () => {
  for (const words of [0, -1, -0, 0.5, 1.5, Number.NaN, Infinity, -Infinity]) {
    assert.throws(() => createRoutingCore({ arenaWords: words }), RangeError, `arenaWords ${words}`)
  }
  // More than the memory can hold, or than grow() takes: refused by a throw, never a silent truncation.
  for (const words of [2 ** 31, 2 ** 32, 2 ** 53, 2 ** 53 + 0.5, Number.MAX_SAFE_INTEGER, 1e300]) {
    assert.throws(() => createRoutingCore({ arenaWords: words }), `arenaWords ${words}`)
  }
  // One word: a core that can lay nothing and says so.
  const one = createRoutingCore({ arenaWords: 1 })
  assert.equal(one.arenaWords, 1)
  for (const t of tracks) assert.equal(one.lay(t), false)
  assert.equal(one.laidCount, 0)
  assert.equal(one.usedWords, 0)
  assert.equal(one.exports.routing_check(0), 0)
  assert.throws(() => one.poseAt(tracks[0], 0), /not laid in the arena/)
})

test('an arena exactly a track\'s words lays it and no other; one word short refuses it, remembers the refusal, and still lays what fits', () => {
  forAll('arena fit', { seed: 0xa5e1, runs: 120 }, (g) => ({ t: g.pick(tracks), other: g.pick(tracks) }), ({ t, other }) => {
    const exact = createRoutingCore({ arenaWords: trackWords(t) })
    assert.equal(exact.lay(t), true)
    assert.equal(exact.usedWords, exact.arenaWords)
    assert.equal(exact.laidCount, 1)
    if (other !== t) {
      assert.equal(exact.lay(other), false, 'a second track never fits a full arena')
      assert.equal(exact.laid(other), false)
      assert.throws(() => exact.poseAt(other, 0), /not laid in the arena/)
    }
    assert.equal(exact.usedWords, exact.arenaWords)
    assert.equal(exact.laidCount, 1)
    identical(exact.poseAt(t, 1).x, referencePoseAt(t, 1).x, `track ${t.id} in an exact arena`)
    const short = createRoutingCore({ arenaWords: trackWords(t) - 1 })
    assert.equal(short.lay(t), false)
    assert.equal(short.lay(t), false, 'the refusal is remembered')
    assert.equal(short.laidCount, 0)
    assert.equal(short.usedWords, 0)
    const smaller = tracks.find((s) => trackWords(s) < trackWords(t))
    if (smaller !== undefined) {
      assert.equal(short.lay(smaller), true, 'a smaller track still fits after a refusal')
      assert.equal(short.usedWords, trackWords(smaller))
      assert.ok(short.usedWords <= short.arenaWords)
    }
  })
})

/** A copy of `t` with one thing a caller could get wrong. */
function malformed(g: Gen, t: Track): { track: Track; why: string } {
  const line = t.pieces.find((p): p is Line => p.kind === 'line')!
  const corner = t.pieces.find((p): p is Corner => p.kind === 'corner')!
  const withPieces = (pieces: Piece[]): Track => ({ ...t, pieces: Object.freeze(pieces) })
  const replace = (p: Piece): Track => withPieces(t.pieces.map((q) => (q === line ? p : q)))
  switch (g.int(0, 13)) {
    case 0: return { track: { ...t, length: g.pick([Number.NaN, 0, -1, Infinity, -Infinity]) }, why: 'length' }
    case 1: return { track: { ...t, y: g.pick([Number.NaN, Infinity]) }, why: 'y' }
    case 2: return { track: { ...t, speedLimit: g.pick([Number.NaN, -Infinity]) }, why: 'speedLimit' }
    case 3: return { track: { ...t, cornerSpeed: Number.NaN }, why: 'cornerSpeed' }
    case 4: return { track: withPieces([]), why: 'no pieces' }
    case 5: return { track: replace({ ...line, length: g.pick([0, -1, Number.NaN, Infinity]) }), why: 'piece length' }
    case 6: return { track: replace({ ...line, s0: g.pick([Number.NaN, Infinity, -1]) }), why: 'piece s0' }
    case 7: return { track: withPieces([{ ...line, s0: 1 }, ...t.pieces.slice(1)]), why: 'first s0 not 0' }
    case 8: return { track: withPieces([...t.pieces].reverse()), why: 'pieces out of order' }
    case 9: return { track: withPieces(t.pieces.map((q) => (q === corner ? { ...corner, lut: new Float32Array(g.pick([0, 32, 34])) } : q))), why: 'lut size' }
    case 10: {
      const arc: Arc = { kind: 'arc', s0: line.s0, length: line.length, cx: 0, cz: 0, radius: 5, a0: 0, sweep: 1 }
      return { track: replace(arc), why: 'an arc' }
    }
    case 11: return { track: { ...t, stops: Object.freeze([{ s: g.pick([Number.NaN, Infinity]), axis: 'ew' as const }, ...t.stops]) }, why: 'stop s' }
    case 12: return { track: replace({ ...line, kind: 'bezier' as unknown as 'line' }), why: 'piece kind' }
    default: return { track: { ...t, stops: Object.freeze([]) }, why: 'no stops (well-formed: lays, nextStop is null)' }
  }
}

test('a malformed track is refused without a trap, leaves the arena as it was, and the next well-formed track lays and answers the reference bit for bit', () => {
  forAll('malformed tracks', { seed: 0xbad7, runs: 400 }, (g) => ({ t: g.pick(cars), next: g.pick(tracks), m: malformed(g, g.pick(cars)) }), ({ t, next, m }) => {
    const core = createRoutingCore({ arenaWords: 4 * trackWords(biggest) })
    assert.equal(core.lay(t), true)
    const used = core.usedWords
    const laid = core.lay(m.track)
    if (m.why.startsWith('no stops')) {
      assert.equal(laid, true, m.why)
      assert.equal(core.nextStop(m.track, 3, 17.4), null)
      assert.equal(referenceNextStop(m.track, 3, 17.4), null)
    } else {
      assert.equal(laid, false, `refused: ${m.why}`)
      assert.equal(core.laid(m.track), false)
      assert.equal(core.usedWords, used, `${m.why}: nothing written for keeps`)
      assert.equal(core.laidCount, 1)
      assert.throws(() => core.poseAt(m.track, 0), /not laid in the arena/)
    }
    // The track laid before is untouched, and the next one lays after the refusal.
    const fresh = createRoutingCore({ arenaWords: 4 * trackWords(biggest) })
    assert.equal(canon(core.poseAt(t, 12.5)), canon(fresh.poseAt(t, 12.5)))
    assert.equal(core.lay(next), true)
    const s = 7.25
    assert.equal(canon(core.poseAt(next, s)), canon(referencePoseAt(next, s)))
    assert.equal(canon(core.projectOnto(next, 10, 10, Number.NaN)), canon(referenceProjectOnto(next, 10, 10, Number.NaN)))
  })
})

// ---------------------------------------------------------------- the arithmetic at the boundaries

test('poseAt, speedLimitAt and nextStop are the reference bit for bit at every extreme double and every piece end nudged by an ulp', () => {
  const core = createRoutingCore()
  forAll('routing bounds s', { seed: 0xb0b1, runs: 10_000 }, (g) => {
    const t = g.pick(tracks)
    return { t, s: edgeS(g, t), behind: g.pick([17.4, 0, g.pick(EXTREME), g.float(0, 40)]) }
  }, ({ t, s, behind }) => {
    const p = core.poseAt(t, s), q = referencePoseAt(t, s)
    for (const k of ['x', 'y', 'z', 'heading', 'tangentX', 'tangentZ'] as const) identical(p[k], q[k], `track ${t.id} s=${s} ${k}`)
    identical(core.speedLimitAt(t, s), referenceSpeedLimitAt(t, s), `track ${t.id} s=${s} speedLimitAt`)
    const a = core.nextStop(t, s, behind), b = referenceNextStop(t, s, behind)
    assert.equal(a === null, b === null, `track ${t.id} s=${s} behind=${behind} nextStop`)
    if (a !== null && b !== null) {
      identical(a.s, b.s, `track ${t.id} s=${s} behind=${behind} nextStop.s`)
      identical(a.distance, b.distance, `track ${t.id} s=${s} behind=${behind} nextStop.distance`)
      assert.equal(a.axis, b.axis)
    }
  })
})

test('projectOnto is the reference bit for bit for points and hints at every extreme double, in lane and a universe away', () => {
  const core = createRoutingCore()
  forAll('routing bounds project', { seed: 0xb0b2, runs: 10_000 }, (g) => {
    const t = g.pick(tracks)
    const q = referencePoseAt(t, g.float(0, t.length))
    const x = g.bool(0.4) ? g.pick(EXTREME) : q.x - q.tangentZ * g.float(-6, 6) + g.float(-1, 1)
    const z = g.bool(0.4) ? g.pick(EXTREME) : q.z + q.tangentX * g.float(-6, 6)
    return { t, x, z, hint: g.pick([Number.NaN, edgeS(g, t), g.pick(EXTREME), g.float(0, t.length)]) }
  }, ({ t, x, z, hint }) => {
    const a = core.projectOnto(t, x, z, hint), b = referenceProjectOnto(t, x, z, hint)
    identical(a.s, b.s, `track ${t.id} (${x}, ${z}) hint ${hint} s`)
    identical(a.lateral, b.lateral, `track ${t.id} (${x}, ${z}) hint ${hint} lateral`)
  })
})

test('two instances, and one instance twice, give bit-identical answers on 5,000 seeded cases', () => {
  const one = createRoutingCore(), two = createRoutingCore()
  const ask = (c: RoutingWasm, t: Track, s: number, x: number, z: number, hint: number, behind: number): string =>
    canon([c.poseAt(t, s), c.projectOnto(t, x, z, hint), c.nextStop(t, s, behind), c.speedLimitAt(t, s)])
  forAll('routing determinism', { seed: 0xde7e, runs: 5_000 }, (g) => {
    const t = g.pick(tracks)
    return { t, s: g.bool(0.3) ? edgeS(g, t) : g.float(-3, 3) * t.length, x: g.float(-500, 500), z: g.float(-500, 500), hint: g.pick([Number.NaN, g.float(-1e6, 1e6), g.pick(EXTREME)]), behind: g.pick([17.4, g.pick(EXTREME)]) }
  }, ({ t, s, x, z, hint, behind }) => {
    const a = ask(one, t, s, x, z, hint, behind)
    assert.equal(ask(two, t, s, x, z, hint, behind), a, `track ${t.id} s=${s}: the two instances differ`)
    assert.equal(ask(one, t, s, x, z, hint, behind), a, `track ${t.id} s=${s}: the same instance differs from itself`)
  })
  assert.equal(one.laidCount, two.laidCount)
  assert.equal(one.usedWords, two.usedWords)
})

// ---------------------------------------------------------------- growth and leaks

test('the module never grows its memory: laying every track of both seeds and 10,000 calls on the largest ring leave memory.buffer and the JS heap where they were', () => {
  const core = createRoutingCore()
  const buffer = core.exports.memory.buffer
  const bytes = buffer.byteLength
  for (const n of networks) for (const t of n.tracks) core.lay(t)
  assert.equal(core.laidCount, tracks.length)
  assert.ok(core.usedWords <= core.arenaWords)
  const gc = (globalThis as { gc?: () => void }).gc
  const heap = (): number => {
    gc?.()
    gc?.()
    return process.memoryUsage().heapUsed
  }
  const calls = (): void => {
    for (let i = 0; i < 10_000; i++) {
      core.poseAt(biggest, i * 1.7)
      core.projectOnto(biggest, (i * 37) % 300, (i * 11) % 200, i % 2 ? Number.NaN : i)
      core.nextStop(biggest, i, 17.4)
      core.speedLimitAt(biggest, i)
    }
  }
  calls()
  const used = core.usedWords
  const h0 = heap()
  calls()
  calls()
  assert.equal(core.exports.memory.buffer, buffer, 'the same ArrayBuffer: nothing grew')
  assert.equal(core.exports.memory.buffer.byteLength, bytes)
  assert.equal(core.usedWords, used, 'a call writes no arena words')
  if (gc !== undefined) {
    const grown = heap() - h0
    assert.ok(grown < 2 * 1024 * 1024, `the JS heap grew ${grown} bytes over 20,000 calls`)
  }
})

// ---------------------------------------------------------------- the module's own ABI

test('the module refuses, without a trap, every word offset past the arena, past 2^31, negative, or too close to the end for a header', () => {
  const core = createRoutingCore({ arenaWords: 4096 })
  core.lay(cars[0])
  const e = core.exports
  const W = core.arenaWords
  for (const at of [W, W + 1, W + 1000, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, -1, -(2 ** 31), W - 1, W - LAYOUT.T_HEADER + 1]) {
    assert.equal(e.routing_check(at), 0, `routing_check(${at})`)
    assert.equal(e.routing_pose_at(at, 0), 0, `routing_pose_at(${at})`)
    assert.equal(e.routing_project_onto(at, 0, 0, Number.NaN), 0, `routing_project_onto(${at})`)
    assert.equal(e.routing_next_stop(at, 0, 17.4), 0, `routing_next_stop(${at})`)
    assert.ok(Number.isNaN(e.routing_speed_limit_at(at, 0)), `routing_speed_limit_at(${at})`)
  }
  // A header of zeros (no pieces) where one fits is no track either.
  assert.equal(e.routing_check(W - LAYOUT.T_HEADER), 0)
  // The arena itself: misaligned, empty, overflowing or past the memory.
  assert.equal(e.routing_arena(4, 8), 0, 'misaligned')
  assert.equal(e.routing_arena(0, 0), 0, 'empty')
  assert.equal(e.routing_arena(8, 2 ** 31 - 1), 0, 'words · 8 overflows')
  assert.equal(e.routing_arena(e.memory.buffer.byteLength, 1), 0, 'past the memory')
  assert.equal(e.routing_arena(e.memory.buffer.byteLength - 8, 2), 0, 'one word past the memory')
  for (const i of [12, 13, 1000, 2 ** 31, 2 ** 32 - 1, -1]) assert.equal(e.routing_layout(i), 0, `routing_layout(${i})`)
  // After every refusal the laid track still answers.
  assert.equal(canon(core.poseAt(cars[0], 5)), canon(referencePoseAt(cars[0], 5)))
})

test('REGRESSION (Phase 16 audit): a header whose piece count makes 42 · pieces + 7 wrap past 2^32 is refused, not trapped, and the instance stays whole', () => {
  // 42 · 102261127 = 2^32 + 38: the words the track "needs" wrap to 45, which fit, and reading piece 1 runs off the slice.
  const core = createRoutingCore({ arenaWords: 1024 })
  const e = core.exports
  const arena = arenaOf(core)
  for (const [pieces, stops] of [[102261127, 0], [102261128, 0], [204522254, 0], [102261127, 400], [51130563, 2 ** 31 + 19]]) {
    arena.set([100, 0, 10, 5, 2, pieces, stops])
    arena.set([0, 0, 100, 0, 0, 1, 0], LAYOUT.T_HEADER)
    const what = `pieces=${pieces} stops=${stops}`
    assert.doesNotThrow(() => assert.equal(e.routing_check(0), 0, `routing_check ${what}`), `routing_check traps on ${what}`)
    assert.doesNotThrow(() => assert.equal(e.routing_pose_at(0, 1), 0, `routing_pose_at ${what}`), `routing_pose_at traps on ${what}`)
    assert.doesNotThrow(() => assert.equal(e.routing_project_onto(0, 1, 2, Number.NaN), 0, `routing_project_onto ${what}`), `routing_project_onto traps on ${what}`)
    assert.doesNotThrow(() => assert.ok(Number.isNaN(e.routing_speed_limit_at(0, 1)), `routing_speed_limit_at ${what}`), `routing_speed_limit_at traps on ${what}`)
    assert.doesNotThrow(() => assert.equal(e.routing_next_stop(0, 1, 2), 0, `routing_next_stop ${what}`), `routing_next_stop traps on ${what}`)
  }
  // Every trap leaks shadow stack (the stack pointer is never restored): a refusal must not be a trap, or the
  // instance dies after ~13,000 of them. Once refusals are refusals, this loop is free.
  arena.set([100, 0, 10, 5, 2, 102261127, 0])
  for (let i = 0; i < 20_000; i++) assert.doesNotThrow(() => e.routing_check(0), `trap ${i}`)
  arena.fill(0)
  assert.equal(core.lay(cars[0]), true, 'a well-formed track lays after 20,000 refusals')
  assert.equal(canon(core.poseAt(cars[0], 3)), canon(referencePoseAt(cars[0], 3)))
})

test('REGRESSION (Phase 16 audit): a grow of the module\'s memory through the host\'s own exports does not leave the host reading detached views', () => {
  const core = createRoutingCore({ arenaWords: 4096 })
  const before = core.poseAt(cars[0], 12.5)
  const grown = core.exports.memory.grow(1)
  assert.ok(grown > 0)
  const after = core.poseAt(cars[0], 12.5)
  assert.equal(canon(after), canon(before), 'the pose after the grow is the pose before it (not undefined through a detached view)')
  assert.equal(canon(after), canon(referencePoseAt(cars[0], 12.5)))
  assert.doesNotThrow(() => assert.equal(core.lay(cars[1]), true), 'laying after a grow throws on a detached view')
  assert.equal(canon(core.poseAt(cars[1], 1)), canon(referencePoseAt(cars[1], 1)))
})

test('the generator and the harness agree on what a seed replays: the first case of a seed is the same case twice', () => {
  const a = gen(0xb0b1), b = gen(0xb0b1)
  const t = tracks[0]
  assert.equal(edgeS(a, t), edgeS(b, t))
})
