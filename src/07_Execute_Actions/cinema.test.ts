// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the cinema camera. The pacer: 24.000 presented frames a second on every common
 * refresh, each frame on the tick nearest its due time, the 2-and-3 hold at 60 Hz, never a burst after a stall, a
 * dropped tick or jitter, and a refresh too slow for 24 drawing every tick. The shutter: exactly 1/48 s of the motion
 * between frames, never more than all of it, nothing across a cut (seat change, teleport, stall), a fast head turn
 * still smeared. The film response: monotonic, calibrated to the ACES mid-grey it replaces, highlights compressed
 * without ever clipping, and shadow detail kept where ACES crushes to black. The ND: none at night, 0.84 stops in
 * daylight, the same exposure the direct path uses. The graph: the velocity buffer, the shutter's three targets, the
 * re-ordered buildings' camera-only motion, and ?cinema=0 untouched. The air gap: nothing the physics worker loads
 * reaches any of it, and the engine requests its step before it asks the pacer anything. The shaders themselves run
 * in a WebGPU browser (the orchestrator's probe).
 * What breaks if it is removed? The frame rate, the blur's length, the cut rule, the tone curve or the worker's
 * isolation could drift unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { InstancedMesh, BoxGeometry, MeshStandardNodeMaterial, PerspectiveCamera, Scene, type WebGPURenderer } from 'three/webgpu'
import { vec2, velocity } from 'three/tsl'
import {
  CINEMA, FILM, FramePacer, HDR_MAX, SHUTTER_SECONDS, acesGrey, exposureFor, filmCurve, isCut, ndDensity, ndGain, shutterScale, type CameraMark,
} from './cinema.ts'
import { SHUTTER, ShutterNode, tileSize } from './shutter.ts'
import { buildPost, pickMotion } from './postfx.ts'
import { ndStopsFor } from '../01_Initialize_World/world.ts'
import { sunAt } from '../01_Initialize_World/solar.ts'

const PERIOD = 1000 / 24

/** Ticks at `hz` for `seconds` from `start`, each nudged by `jitter(k)` ms; returns the presented tick times. */
function run(p: FramePacer, hz: number, seconds: number, start = 1000, jitter: (k: number) => number = () => 0): number[] {
  const out: number[] = []
  const r = 1000 / hz
  for (let k = 0; k <= Math.round(hz * seconds); k++) {
    const t = start + k * r + jitter(k)
    if (p.tick(t)) out.push(t)
  }
  return out
}
const gaps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i])
/** Deterministic noise in [-1, 1) (a 32-bit LCG). */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 31 - 1
  }
}

// ---------------------------------------------------------------------------------------------------
// The pacer

test('pacer: 24.000 frames a second on every common refresh, each on the tick nearest its due time', () => {
  for (const hz of [24, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240]) {
    const p = new FramePacer()
    const shown = run(p, hz, 10)
    assert.equal(shown.length, 241, `${hz} Hz: 10 s holds 240 intervals`)
    const r = 1000 / hz
    // Due times run from the first frame in exact periods (plus the phase, at most half a refresh); each frame is
    // within half a refresh of its own due time.
    shown.forEach((t, k) => assert.ok(Math.abs(t - (shown[0] + k * PERIOD)) <= r + 1e-6, `${hz} Hz frame ${k} is ${(t - shown[0] - k * PERIOD).toFixed(3)} ms off`))
    // Holds are the two whole numbers of refreshes around the period (just one where it divides evenly).
    const holds = new Set(gaps(shown).map((g) => Math.round(g / r)))
    const lo = Math.floor(PERIOD / r + 1e-9), hi = Math.ceil(PERIOD / r - 1e-9)
    for (const h of holds) assert.ok(h === lo || h === hi, `${hz} Hz: a hold of ${h} refreshes (expected ${lo} or ${hi})`)
    assert.ok(Math.abs(p.fps(shown.at(-1)!) - 24) < 1e-9, `${hz} Hz measures ${p.fps(shown.at(-1)!)}`)
    assert.ok(Math.abs(p.refreshMs - r) < 1e-9, `${hz} Hz refresh estimate ${p.refreshMs}`)
  }
})

test('pacer: 60 Hz alternates holds of 2 and 3 refreshes (the 3:2 cadence); 120 and 144 Hz hold evenly', () => {
  const at60 = gaps(run(new FramePacer(), 60, 2)).map((g) => Math.round(g / (1000 / 60)))
  for (let i = 1; i < at60.length; i++) assert.notEqual(at60[i], at60[i - 1], `60 Hz holds ${at60.join(',')}`)
  assert.deepEqual([...new Set(at60)].sort(), [2, 3])
  assert.deepEqual([...new Set(gaps(run(new FramePacer(), 120, 2)).map((g) => Math.round(g / (1000 / 120))))], [5])
  assert.deepEqual([...new Set(gaps(run(new FramePacer(), 144, 2)).map((g) => Math.round(g / (1000 / 144))))], [6])
})

/** Holds (in refreshes) that break the ideal cadence: a length other than the two around the period, or a run of one
 *  length longer than an even spread of the long holds allows (2,2 or 3,3 at 60 Hz). */
function hiccups(shown: number[], hz: number): number {
  const r = 1000 / hz, ratio = PERIOD / r
  const lo = Math.floor(ratio + 1e-9), hi = Math.ceil(ratio - 1e-9), frac = ratio - lo
  let bad = 0, run = 0, prev = -1
  for (const h of gaps(shown).map((g) => Math.round(g / r))) {
    if (h !== lo && h !== hi) bad++
    run = h === prev ? run + 1 : 1
    prev = h
    if (lo !== hi && ((h === lo && run > Math.ceil((1 - frac) / frac - 1e-9)) || (h === hi && run > Math.ceil(frac / (1 - frac) - 1e-9)))) bad++
  }
  return bad
}

test('pacer: browser timestamps (rounded to 0.1 ms, jittered) keep the 3:2 cadence clean: the phase keeps due times off the ties', () => {
  for (const [hz, amp] of [[60, 0], [60, 0.3], [60, 1], [59.94, 0.3], [30, 0], [30, 1], [120, 1], [144, 0.5]] as const) {
    const noise = lcg(Math.round(hz * 10 + amp * 7))
    const p = new FramePacer()
    const r = 1000 / hz
    const shown: number[] = []
    for (let k = 0; k < hz * 120; k++) {
      const t = Math.round((1000 + k * r + noise() * amp) * 10) / 10
      if (p.tick(t)) shown.push(t)
    }
    // Once the phase has settled (the first 3 s), two minutes without more than a couple of stutters.
    const bad = hiccups(shown.filter((t) => t > 4000), hz)
    assert.ok(bad <= 2, `${hz} Hz ±${amp} ms: ${bad} cadence hiccups in two minutes`)
    const rate = ((shown.length - 1) * 1000) / (shown.at(-1)! - shown[0])
    assert.ok(Math.abs(rate - 24) < 0.01, `${hz} Hz ±${amp} ms: ${rate} fps`)
  }
  // The same timestamps without the phase would stutter every few frames: the ties are real.
  let tied = 0
  for (let k = 1; k < 1000; k++) {
    const due = 1000 + k * PERIOD, before = Math.round((1000 + Math.floor((due - 1000) / (1000 / 60)) * (1000 / 60)) * 10) / 10
    if (Math.abs(due - (1000 / 60) / 2 - before) < 0.1) tied++
  }
  assert.ok(tied > 400, `due times on a tick midpoint: ${tied} of 1000`)
})

test('pacer: jittered vsync timestamps keep 24 a second and never hurry a frame', () => {
  for (const [hz, amp] of [[60, 1], [60, 3], [90, 1], [144, 0.5], [120, 2]] as const) {
    const noise = lcg(hz * 100 + amp)
    const p = new FramePacer()
    const shown = run(p, hz, 20, 1000, () => noise() * amp)
    assert.ok(Math.abs(shown.length - 481) <= 2, `${hz} Hz ±${amp} ms: ${shown.length} frames in 20 s`)
    const r = 1000 / hz
    // Never closer than the 3:2 cadence's short hold (the whole number of refreshes below the period).
    const shortest = Math.floor(PERIOD / r) * r - 2 * amp
    for (const g of gaps(shown)) assert.ok(g >= shortest - 1e-6, `${hz} Hz ±${amp} ms: a ${g.toFixed(2)} ms hold`)
  }
})

test('pacer: after a stall (hidden tab, hitch) one frame, then the cadence resumes from it: no catch-up burst', () => {
  for (const stall of [60, 100, 250, 1000, 5000]) {
    const p = new FramePacer()
    const before = run(p, 60, 2, 1000)
    const resume = before.at(-1)! + stall
    const after = run(p, 60, 2, resume)
    assert.equal(after[0], resume, `${stall} ms: the first tick after the stall is drawn`)
    const r = 1000 / 60
    for (const g of gaps(after)) assert.ok(g >= 2 * r - 1e-6, `${stall} ms stall: a ${g.toFixed(2)} ms hold afterwards`)
    // Back to exactly 24 a second from the new anchor.
    assert.equal(after.length, 49, `${stall} ms: ${after.length} frames in the 2 s after`)
  }
})

test('pacer: a dropped tick (a long frame) never shortens the next hold below two refreshes', () => {
  const r = 1000 / 60
  for (let drop = 0; drop < 10; drop++) {
    const p = new FramePacer()
    const shown: number[] = []
    for (let k = 0; k < 600; k++) {
      if (k % 50 === 20 + drop) continue // one missing vsync every 50
      const t = 1000 + k * r
      if (p.tick(t)) shown.push(t)
    }
    for (const g of gaps(shown)) assert.ok(g >= 2 * r - 1e-6, `drop at ${drop}: a ${g.toFixed(2)} ms hold`)
    assert.ok(shown.length >= 236 && shown.length <= 241, `drop at ${drop}: ${shown.length} frames in 10 s`)
  }
})

test('pacer: a refresh too slow for 24 draws every tick; irregular slow ticks never burst', () => {
  for (const hz of [10, 15, 20, 23]) {
    const p = new FramePacer()
    const ticks = Math.round(hz * 5) + 1
    assert.equal(run(p, hz, 5).length, ticks, `${hz} Hz`)
  }
  // Irregular: 11 ms ticks with long gaps (a contended GPU in a headless browser).
  const noise = lcg(7)
  const p = new FramePacer()
  const shown: number[] = []
  let t = 1000
  for (let k = 0; k < 2000; k++) {
    t += noise() > 0.6 ? 11.1 * (2 + Math.floor((noise() + 1) * 4)) : 11.1
    if (p.tick(t)) shown.push(t)
  }
  const shortest = Math.min(...gaps(shown))
  assert.ok(Math.abs(p.refreshMs - 11.1) < 1e-9, `the refresh is read from the short intervals (${p.refreshMs})`)
  assert.ok(shortest >= PERIOD * 0.6 - 1e-6, `shortest hold ${shortest.toFixed(2)} ms`)
  // The same holds for a pacer that has seen nothing but long, uneven ticks from its very first frame.
  for (let seed = 1; seed <= 20; seed++) {
    const n = lcg(seed)
    const q = new FramePacer()
    const out: number[] = []
    let u = 1000
    for (let k = 0; k < 300; k++) {
      u += 5 + (n() + 1) * 30
      if (q.tick(u)) out.push(u)
    }
    assert.ok(Math.min(...gaps(out)) >= PERIOD * 0.6 - 1e-6, `seed ${seed}: a ${Math.min(...gaps(out)).toFixed(2)} ms hold`)
  }
  const rate = ((shown.length - 1) * 1000) / (shown.at(-1)! - shown[0])
  assert.ok(rate <= 24 + 1e-9, `rate ${rate}`)
})

test('pacer: the refresh is read from the short tick intervals, even when most frames are dropped', () => {
  // A GPU-bound page on a 90 Hz display: three ticks in five arrive a refresh late (22.2 ms).
  const p = new FramePacer()
  const r = 1000 / 90
  let t = 1000
  const shown: number[] = []
  for (let k = 0; k < 900; k++) {
    t += k % 5 < 3 ? 2 * r : r
    if (p.tick(t)) shown.push(t)
  }
  assert.ok(Math.abs(p.refreshMs - r) < 1e-9, `refresh ${p.refreshMs} (the display's is ${r})`)
  const rate = ((shown.length - 1) * 1000) / (shown.at(-1)! - shown[0])
  assert.ok(rate <= 24 + 1e-9 && rate > 22, `${rate} fps`)
})

test('pacer: the first tick is drawn; a clock that runs backwards re-anchors; NaN and ±Infinity are ignored', () => {
  const p = new FramePacer()
  assert.equal(p.tick(5000), true)
  assert.equal(p.tick(5016.7), false)
  for (const bad of [Number.NaN, Infinity, -Infinity]) assert.equal(p.tick(bad), false)
  assert.equal(p.tick(5030), false, 'still more than half a refresh before the 5041.7 due time')
  assert.equal(p.tick(5040), true, 'the cadence carried on through the bad timestamps')
  assert.equal(p.frames, 2)
  // A new time origin (smaller timestamps): drawn at once, and 24 a second from there.
  assert.equal(p.tick(100), true)
  assert.equal(run(p, 60, 1, 116.66666666666667).length, 24)
  assert.equal(p.lastPresentMs > 100, true)
})

test('pacer: fps() needs two frames, measures the last 24 intervals, and reads 0 a second after the last frame', () => {
  const p = new FramePacer()
  assert.equal(p.fps(0), 0)
  assert.ok(Number.isNaN(p.lastPresentMs))
  p.tick(1000)
  assert.equal(p.fps(1000), 0)
  const shown = run(p, 60, 3, 1000 + 1000 / 60)
  const last = shown.at(-1)!
  assert.ok(Math.abs(p.fps(last + 500) - 24) < 1e-9)
  assert.equal(p.fps(last + 1000), 0)
  assert.equal(p.lastPresentMs, last)
  assert.throws(() => new FramePacer(0), RangeError)
  assert.throws(() => new FramePacer(Number.NaN), RangeError)
  assert.equal(new FramePacer(25).periodMs, 40)
})

// ---------------------------------------------------------------------------------------------------
// The shutter

test('shutter: 180° at 24 fps is 1/48 s; the blur takes exactly that much of the motion between frames', () => {
  assert.equal(CINEMA.fps, 24)
  assert.equal(CINEMA.shutterAngle, 180)
  assert.equal(SHUTTER_SECONDS, 1 / 48)
  const r = 1000 / 60
  assert.ok(Math.abs(shutterScale(2 * r) - 0.625) < 1e-12, 'a 2-refresh hold at 60 Hz')
  assert.ok(Math.abs(shutterScale(3 * r) - 1 / 2.4) < 1e-12, 'a 3-refresh hold')
  assert.ok(Math.abs(shutterScale(PERIOD) - 0.5) < 1e-12, 'an even 24')
  // Whatever the hold, scale × interval is the exposure.
  for (const ms of [20.84, 33.3, 41.7, 50, 66.7, 100, 250]) assert.ok(Math.abs(shutterScale(ms) * ms - 1000 / 48) < 1e-9, `${ms} ms`)
  // Never more than all the motion; nothing for a non-interval or a stall.
  for (const ms of [0.5, 5, 10, 20.8]) assert.equal(shutterScale(ms), 1)
  for (const ms of [0, -5, Number.NaN, Infinity, 250.01, 1000]) assert.equal(shutterScale(ms), 0, `${ms}`)
})

test('cuts: the first frame, a stall, a seat change and a teleport are cuts; walking, driving and a fast head turn are not', () => {
  const at = (x: number, z: number, seat = -1): CameraMark => ({ x, y: 1.7, z, seat })
  assert.equal(isCut(null, at(0, 0), 41.7), true, 'no previous frame')
  assert.equal(isCut(at(0, 0), at(0.05, 0), 300), true, 'a stall')
  assert.equal(isCut(at(0, 0), at(0.05, 0), Number.NaN), true)
  assert.equal(isCut(at(0, 0, -1), at(0.3, 0, 4), 41.7), true, 'getting into car 4')
  assert.equal(isCut(at(0, 0, 4), at(0.3, 0, -1), 41.7), true, 'getting out')
  assert.equal(isCut(at(0, 0, 4), at(0.3, 0, 5), 41.7), true, 'a different car')
  assert.equal(isCut(at(0, 0), at(40, 0), 41.7), true, 'a 40 m teleport')
  assert.equal(isCut(at(0, 0), at(Number.NaN, 0), 41.7), true, 'a broken position')
  assert.equal(isCut(at(0, 0), at(0.25, 0), 50), false, 'running (5 m/s)')
  assert.equal(isCut(at(0, 0, 3), at(2.5, 0, 3), 50), false, 'driving at 50 m/s')
  assert.equal(isCut(at(0, 0, 3), at(4.4, 0, 3), 50), false, 'just under 90 m/s')
  assert.equal(isCut(at(0, 0, 3), at(4.6, 0, 3), 50), true, 'just over')
  assert.equal(isCut(at(0, 0), at(0, 0), 41.7), false, 'standing still, turning the head (the pose is not position)')
})

test('exposure: the frame\'s blur is the shutter\'s share of the interval, and nothing across a cut or without the post chain', () => {
  const at = (x: number, seat = -1): CameraMark => ({ x, y: 1.7, z: 0, seat })
  assert.equal(exposureFor(at(0), at(0.1), 1000 / 30, true), shutterScale(1000 / 30))
  assert.equal(exposureFor(at(0), at(0.1), 50, true), shutterScale(50))
  assert.equal(exposureFor(at(0), at(0.1), 50, false), 0, 'drawn directly: no velocity buffer')
  assert.equal(exposureFor(null, at(0.1), 50, true), 0, 'the last frame had no velocity buffer (or none yet)')
  assert.equal(exposureFor(at(0, -1), at(0.1, 2), 50, true), 0, 'into the driver\'s seat')
  assert.equal(exposureFor(at(0), at(30), 50, true), 0, 'a teleport')
  assert.equal(exposureFor(at(0), at(0.1), 400, true), 0, 'a stall')
})

// ---------------------------------------------------------------------------------------------------
// The film response and the ND

/** Display-linear → 8-bit sRGB code value (0..255, unrounded). */
const code = (y: number) => 255 * (y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055)
const DAY = 2 ** -ndStopsFor(1)

test('film: monotonic over 30 stops, 0 for nothing, below 1 for everything the half-float target holds', () => {
  let prev = 0
  for (let e = -24; e <= 17; e += 0.05) {
    const y = filmCurve(2 ** e)
    assert.ok(y > prev || (y === prev && y === 0) || 2 ** e >= HDR_MAX, `2^${e.toFixed(2)}: ${y} after ${prev}`)
    assert.ok(y < 1, `2^${e.toFixed(2)} reaches white`)
    prev = y
  }
  for (const x of [0, -1, -Infinity, Number.NaN]) assert.equal(filmCurve(x), 0)
  assert.ok(filmCurve(Infinity) < 1 && filmCurve(Infinity) > 0.9999999, 'an infinite highlight is white, not NaN')
  assert.equal(filmCurve(Infinity), filmCurve(HDR_MAX))
})

test('acesGrey mirrors three.js\'s ACES fit exactly (its denominator is 0.983729·v·(v + 0.432951) + 0.238081)', () => {
  // Values of three's RRTAndODTFit(x / 0.6) for grey, which its input and output matrices leave grey.
  const three = (x: number) => { const v = x / 0.6; return (v * (v + 0.0245786) - 0.000090537) / (0.983729 * v * (v + 0.432951) + 0.238081) }
  for (const x of [0.01, 0.1008, 0.18, 0.5, 1, 4]) assert.ok(Math.abs(acesGrey(x) - three(x)) < 1e-12, `${x}`)
  assert.ok(Math.abs(acesGrey(0.1008) - 0.0956222) < 1e-6, `${acesGrey(0.1008)}`)
  // The textbook fit (0.432951 outside the product) is a different curve: the mirror is not it.
  const textbook = (x: number) => { const v = x / 0.6; return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081) }
  assert.ok(Math.abs(acesGrey(0.1008) - textbook(0.1008)) > 2e-4)
  assert.equal(acesGrey(0), 0, 'the black offset clamps to zero')
  assert.equal(acesGrey(1000), 1, 'and the top clips to one')
})

test('film: mid-grey lands where ACES put it under daylight (the default 17:00 look keeps its brightness)', () => {
  assert.ok(Math.abs(FILM.anchor - 0.18 * DAY) < 1e-12, 'anchored at the full-daylight exposure')
  assert.ok(Math.abs(DAY - 2 ** -ndStopsFor(sunAt(17).daylight)) < 1e-12, '17:00 is full daylight')
  assert.ok(Math.abs(filmCurve(FILM.anchor) - acesGrey(FILM.anchor)) < 1e-12)
  // Night (no ND): within 4 % of ACES at mid-grey, about three code values.
  const night = 0.18
  assert.ok(Math.abs(filmCurve(night) / acesGrey(night) - 1) < 0.07, `night mid-grey ${filmCurve(night)} vs ${acesGrey(night)}`)
  assert.ok(Math.abs(code(filmCurve(night)) - code(acesGrey(night))) < 4)
  // The straight portion: a film-like gamma through the mid-tones, softer than ACES's.
  const slope = (f: (x: number) => number, x: number) => (Math.log(f(x * 1.01)) - Math.log(f(x / 1.01))) / (2 * Math.log(1.01))
  const film = slope(filmCurve, FILM.anchor), aces = slope(acesGrey, FILM.anchor)
  assert.ok(film > 1.2 && film < 1.45, `film mid-tone gamma ${film}`)
  assert.ok(film < aces, `ACES mid-tone gamma ${aces}`)
})

test('film: shadows are kept where ACES crushes them: brighter below mid-grey, never zero, more code values', () => {
  let filmCodes = new Set<number>(), acesCodes = new Set<number>()
  let crushedByAces = 0
  for (let stops = -1; stops >= -9; stops -= 1 / 16) {
    const x = FILM.anchor * 2 ** stops
    const f = filmCurve(x), a = acesGrey(x)
    assert.ok(f >= a, `${stops.toFixed(2)} stops: film ${f} below ACES ${a}`)
    assert.ok(f > 0, `${stops.toFixed(2)} stops: film at black`)
    if (a === 0) crushedByAces++
    filmCodes.add(Math.round(code(f)))
    acesCodes.add(Math.round(code(a)))
  }
  assert.ok(crushedByAces > 40, 'ACES clips the bottom three stops of this range to black')
  assert.equal(acesGrey(FILM.anchor * 2 ** -6), 0)
  assert.ok(code(filmCurve(FILM.anchor * 2 ** -6)) > 0.5, 'six stops under, the film still has a code value')
  assert.ok(filmCodes.size > acesCodes.size, `distinct shadow codes: film ${filmCodes.size}, ACES ${acesCodes.size}`)
  filmCodes = new Set(); acesCodes = new Set()
})

test('film: highlights are compressed, never clipped: ACES hits white where the film is still separating tones', () => {
  const aClip = [4, 5, 6, 7, 8, 9, 10].map((s) => acesGrey(FILM.anchor * 2 ** s))
  assert.ok(aClip.slice(4).every((y) => y === 1), `ACES at +8..+10 stops: ${aClip}`)
  let prev = 0
  for (let s = 0; s <= 12; s += 0.5) {
    const y = filmCurve(FILM.anchor * 2 ** s)
    assert.ok(y > prev && y < 1, `+${s} stops: ${y}`)
    prev = y
  }
  // The shoulder: ±1 stop around +3 still spans a real range of display values.
  assert.ok(filmCurve(FILM.anchor * 16) - filmCurve(FILM.anchor * 4) > 0.1)
})

test('ND: none at night, 0.84 stops (ND 0.25) in daylight, the exposure the direct path uses', () => {
  assert.equal(ndStopsFor(0), 0)
  assert.ok(Math.abs(ndStopsFor(1) + Math.log2(0.56)) < 1e-12)
  assert.ok(Math.abs(ndDensity(ndStopsFor(1)) - 0.2518) < 1e-3, `ND ${ndDensity(ndStopsFor(1))}`)
  for (let d = 0; d <= 1; d += 0.05) {
    assert.ok(Math.abs(ndGain(ndStopsFor(d)) - (0.56 + 0.44 * (1 - d))) < 1e-12, `daylight ${d}`)
    if (d > 0) assert.ok(ndStopsFor(d) > ndStopsFor(d - 0.05), 'more light, more ND')
  }
  for (const d of [Number.NaN, -1, -Infinity]) assert.equal(ndStopsFor(d), 0)
  assert.equal(ndStopsFor(2), ndStopsFor(1))
  assert.equal(ndGain(1), 0.5)
  assert.equal(ndGain(Number.NaN), 1)
  assert.ok(Math.abs(ndDensity(1) - 0.30103) < 1e-5, 'ND 0.3 is one stop')
})

// ---------------------------------------------------------------------------------------------------
// The graph (no GPU in Node: structure only)

test('shutter: tiles of 20 px per 720 px of height (8..40), covering the whole target', () => {
  assert.equal(tileSize(720), 20)
  assert.equal(tileSize(1080), 30)
  assert.equal(tileSize(2160), 40)
  assert.equal(tileSize(100), 8)
  assert.equal(SHUTTER.taps % 2, 1, 'odd: the centre tap is the pixel')
  const s = new ShutterNode(null as never, null as never)
  const targets = s as unknown as Record<'tileTarget' | 'neighbourTarget' | 'output', { width: number; height: number }>
  s.setSize(1280, 720)
  assert.deepEqual([targets.output.width, targets.output.height], [1280, 720])
  assert.deepEqual([targets.tileTarget.width, targets.tileTarget.height], [64, 36])
  s.setSize(1281, 721)
  assert.deepEqual([targets.tileTarget.width, targets.tileTarget.height], [65, 37], 'a partial tile still gets a texel')
  assert.deepEqual([targets.neighbourTarget.width, targets.neighbourTarget.height], [65, 37])
  assert.equal(s.exposure.value, 0, 'still until the engine opens it')
  s.dispose()
})

test('pickMotion: the re-ordered instances move with the camera alone; every other material writes the object velocity', () => {
  const buildings = new MeshStandardNodeMaterial(), car = new MeshStandardNodeMaterial()
  const cameraOnly = vec2(0.25, -0.5)
  const resorted = new Set<unknown>([buildings])
  assert.equal(pickMotion(buildings, resorted, cameraOnly), cameraOnly)
  assert.equal(pickMotion(car, resorted, cameraOnly), velocity)
  assert.equal(pickMotion(buildings, new Set(), cameraOnly), velocity, 'nothing re-ordered: everything writes velocity')
})

test('buildPost: cinema writes a velocity buffer, the re-ordered buildings report camera-only motion, and ?cinema=0 is untouched', () => {
  const renderer = { toneMapping: 4, outputColorSpace: 'srgb', reversedDepthBuffer: false } as unknown as WebGPURenderer
  const mesh = () => new InstancedMesh(new BoxGeometry(), new MeshStandardNodeMaterial(), 4)
  const buildings = mesh()
  const on = buildPost(renderer, new Scene(), new PerspectiveCamera(), { resorted: [buildings] })
  assert.ok(on.cinema)
  assert.ok(on.cinema.shutter instanceof ShutterNode)
  assert.equal(on.cinema.shutter.exposure.value, 0)
  assert.equal(on.cinema.nd.value, 0)
  assert.equal(on.cinema.exposure.value, 1)
  assert.ok(on.pipeline.outputNode)
  assert.equal(on.pipeline.outputColorTransform, false, 'the film and sRGB are applied explicitly before FXAA')
  // No material-level MRT: it would follow the buildings into the renderer's direct draw (post off at the Minimal
  // tier), where a velocity-only output compiles to an empty shader struct. They pick their motion in the pass (below).
  assert.equal((buildings.material as MeshStandardNodeMaterial).mrtNode, null, 'no material carries an MRT of its own')
  // The scene pass the shutter reads writes colour and the velocity buffer side by side.
  const scenePass = (on.cinema.shutter as unknown as { motion: { passNode: { getMRT(): { has(k: string): boolean } | null } } }).motion.passNode
  const passMrt = scenePass.getMRT()
  assert.ok(passMrt && passMrt.has('output') && passMrt.has('velocity'), 'the scene pass writes output and velocity')
  const plain = mesh()
  const off = buildPost(renderer, new Scene(), new PerspectiveCamera(), null)
  assert.equal(off.cinema, null)
  assert.equal((plain.material as MeshStandardNodeMaterial).mrtNode, null)
  // Walking each chain's node graph finds its one scene pass: with the camera it writes the velocity buffer, without it
  // the colour alone (?cinema=0 renders exactly as before).
  const passes = (root: unknown) => {
    type N = { isPassNode?: boolean; getChildren?: () => Iterable<unknown>; getMRT?: () => { has(k: string): boolean } | null }
    const seen = new Set<unknown>(), found: N[] = []
    const visit = (n: unknown) => {
      if (!n || typeof n !== 'object' || seen.has(n)) return
      seen.add(n)
      const node = n as N
      if (node.isPassNode) found.push(node)
      for (const c of node.getChildren?.() ?? []) visit(c)
    }
    visit(root)
    return found
  }
  const [onPass, ...moreOn] = passes(on.pipeline.outputNode)
  const [offPass, ...moreOff] = passes(off.pipeline.outputNode)
  assert.ok(onPass && moreOn.length === 0 && offPass && moreOff.length === 0, 'one scene pass per chain')
  assert.equal(onPass, scenePass as unknown, 'the pass the shutter reads is the chain\'s scene pass')
  assert.equal(offPass.getMRT!(), null, '?cinema=0: no velocity buffer')
})

// ---------------------------------------------------------------------------------------------------
// The air gap

/** Every module a file loads, transitively, through relative static imports and re-exports. */
function importGraph(entry: URL): Set<string> {
  const seen = new Set<string>()
  const visit = (u: URL) => {
    if (seen.has(u.href)) return
    seen.add(u.href)
    const src = readFileSync(u, 'utf8')
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^'";]*?from\s+'(\.[^']+)'|^\s*import\s+'(\.[^']+)'/gm)) {
      const spec = m[1] ?? m[2]
      if (spec.endsWith('.ts') || spec.endsWith('.wgsl')) visit(new URL(spec, u))
    }
    for (const m of src.matchAll(/new URL\('(\.[^']+\.ts)'/g)) visit(new URL(m[1], u))
  }
  visit(entry)
  return seen
}

test('air gap: nothing the physics worker loads reaches the camera, the shutter, the post chain or the engine', () => {
  const graph = importGraph(new URL('./physics.worker.ts', import.meta.url))
  assert.ok(graph.size > 5, `the worker's graph was read (${graph.size} modules)`)
  for (const f of ['cinema.ts', 'shutter.ts', 'postfx.ts', 'ghost.ts', 'engine.ts', 'head.ts', 'fleetView.ts', 'viewports.ts', 'controls.ts']) {
    assert.ok(![...graph].some((u) => u.endsWith(`/07_Execute_Actions/${f}`)), `the worker loads ${f}`)
  }
  // The camera's arithmetic imports nothing at all; its protocol with the worker is unchanged (no camera fields).
  assert.doesNotMatch(readFileSync(new URL('./cinema.ts', import.meta.url), 'utf8'), /^\s*import\s/m)
  assert.doesNotMatch(readFileSync(new URL('./simProtocol.ts', import.meta.url), 'utf8'), /cinema|shutter|pacer|present/i)
})

test('air gap: every animation frame requests its physics step and poses the head before the pacer is asked; only present() draws', () => {
  const src = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8')
  const frame = src.slice(src.indexOf('  frame(nowMs: number): void {'), src.indexOf('  /** One drawn frame:'))
  const present = src.slice(src.indexOf('  private present('), src.indexOf('  private expose('))
  const at = (s: string, needle: string) => {
    const i = s.indexOf(needle)
    assert.ok(i >= 0, `missing ${needle}`)
    return i
  }
  const pacer = at(frame, 'this.pacer.tick(nowMs)')
  for (const before of ['input.poll(dt)', 'sim.request({ dt: this.pendingDt, foot, drive })', 'this.rumble(rumble)', 'this.rig.inVehicle(', 'this.rig.onFoot(']) {
    assert.ok(at(frame, before) < pacer, `${before} waits for the pacer`)
  }
  // The step request is unconditional: every animation frame sends one (the worker keeps its own pace).
  assert.match(frame, /^ {4}if \(sim\.request\(\{ dt: this\.pendingDt, foot, drive \}\)\) this\.pendingDt = 0$/m)
  assert.match(frame, /^ {4}input\.poll\(dt\)$/m)
  assert.ok(at(frame, 'this.listen(dt, st)') > pacer, 'the audio listener is fed every frame')
  assert.doesNotMatch(frame.slice(pacer), /\breturn\b/, 'nothing after the pacer skips the rest of the frame')
  // The pacer gates the draw and nothing else: present(), and the governor told of the frame the camera presented.
  const gated = /if \(this\.pacer === null \|\| this\.pacer\.tick\(nowMs\)\) \{\n((?:\s*\/\/.*\n)*)\s*if \(this\.pacer !== null\) this\.quality\.governor\.present\(nowMs\)\n\s*this\.present\(nowMs, st, focusX, focusZ\)\n\s*\}/
  assert.match(frame, gated, 'the pacer only gates present() (and the governor hears of each presented frame)')
  assert.ok(!frame.includes('.render('), 'frame() itself draws nothing')
  assert.ok(present.includes('this.post.render()') && present.includes('this.gpu.renderer.render(this.world.scene, cam)'))
})
