// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Node has no Web Audio, so it proves the soundscape's maths directly (gearbox
 * hysteresis, gain curves, Doppler, listener basis, voice assignment, the synthesized buffers) and drives
 * the Soundscape class against a strict fake audio graph that, like browsers, throws on non-finite
 * automation values: voices fade before they switch cars, the listener falls back to the legacy API,
 * walk tones start and stop per phase, speech is decoded from a copy, said at the speaker's head, follows them, is
 * muffled by the walls of the city's own geometry between them and the listener (and only by walls in the way), fades
 * out when cut (one utterance at a time), and nothing runs before unlock or after dispose.
 * What breaks if it is removed? Clicks, voice hopping, silent walk signals, speech from the wrong place or an
 * AudioParam exception inside the frame loop would only be found by ear in a browser.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Euler, Vector3 } from 'three'
import {
  APS, BabbleRender, CABIN, CAPTION_REFRESH, CUE, ENGINE, MURMUR, OCCLUSION, PING, REVERB, SPEECH, SYNTH_RATE, VOICE, Soundscape, assignVoices, carLoudness, carTimbre, distanceGain,
  dopplerFactor, engineCutoff, engineLevel, engineLoad, engineRpm, engineWave, listenerBasis, muffle, murmurLayout, murmurLevel,
  murmurSwell, pingLength, renderBabble, renderNoise, renderPing, renderSignalTone, selectGear, signalToneLength, tyreCutoff, tyreLevel,
  volumeToGain, cueLength, renderCue, sharedAudioContext, toHeadSpace, wallsBetween, type AudioFrame, type CarSample,
} from './audio.ts'
import { ACOUSTICS, eavesdrop, impulseLength, renderImpulse, roomAt, roomKey, sabineRt60, type Room } from './acoustics.ts'
import type { CaptionEvent } from './captions.ts'
import { CITY, LAKE, generateBuildings, inLot, type Box } from '../01_Initialize_World/city.ts'
import { createRng } from '../02_Define_The_Rules/degrees.ts'

const near = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, msg ?? `${a} ≉ ${b} (±${tol})`)

/** Goertzel power of `x[from, to)` at `f` Hz, normalised by length². */
function power(x: Float32Array, rate: number, f: number, from = 0, to = x.length): number {
  const c = 2 * Math.cos((2 * Math.PI * f) / rate)
  let s1 = 0, s2 = 0
  for (let i = from; i < to; i++) { const s = x[i] + c * s1 - s2; s2 = s1; s1 = s }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / ((to - from) * (to - from))
}

const car = (x: number, z: number, speed = 0, heading = 0, player = false): CarSample => ({ x, z, heading, speed, player })

// ---------------------------------------------------------------------------------------------- maths

test('distance gain is Web Audio\'s inverse model; volume taper is monotonic and clamped', () => {
  assert.equal(distanceGain(0, 4, 1.2), 1)
  assert.equal(distanceGain(4, 4, 1.2), 1)
  near(distanceGain(10, 4, 1.2), 4 / (4 + 1.2 * 6), 1e-12)
  for (let d = 4; d < 100; d += 3) assert.ok(distanceGain(d + 1, 4, 1.2) < distanceGain(d, 4, 1.2))
  assert.equal(volumeToGain(0), 0)
  assert.equal(volumeToGain(1), 1)
  assert.equal(volumeToGain(-3), 0)
  assert.equal(volumeToGain(7), 1)
  assert.equal(volumeToGain(Number.NaN), 0)
  for (let v = 0; v < 1; v += 0.05) assert.ok(volumeToGain(v + 0.05) > volumeToGain(v))
})

test('gearbox: idles at rest, shifts with hysteresis, never chatters at a shift point', () => {
  assert.equal(selectGear(0, 3), 0)
  near(engineRpm(0, 0), ENGINE.idleRpm, 1e-9)
  // Sweep up: rpm stays inside the band between idle and just past the upshift point.
  let g = 0
  const ups: number[] = []
  for (let v = 0; v <= 30; v += 0.05) {
    const next = selectGear(v, g)
    if (next > g) ups.push(v)
    g = next
    // Upshifts key on the wheel-driven rpm; the idle blend adds a little on top.
    assert.ok(engineRpm(v, g) <= Math.hypot(ENGINE.idleRpm, ENGINE.upshiftRpm) * 1.01 || g === ENGINE.gears.length - 1, `rpm ${engineRpm(v, g)} at ${v}`)
    assert.ok(engineRpm(v, g) >= ENGINE.idleRpm)
  }
  assert.equal(ups.length, ENGINE.gears.length - 1)
  // Sweep down: downshifts happen at lower speeds than the upshifts (hysteresis).
  const downs: number[] = []
  for (let v = 30; v >= 0; v -= 0.05) {
    const next = selectGear(v, g)
    if (next < g) downs.unshift(v)
    g = next
  }
  assert.equal(downs.length, ENGINE.gears.length - 1)
  for (let i = 0; i < ups.length; i++) assert.ok(downs[i] < ups[i] - 0.5, `gear ${i + 1}: down ${downs[i]} vs up ${ups[i]}`)
  // A car hovering ±0.2 m/s around the first upshift point shifts once, not every frame.
  let shifts = 0
  g = 0
  for (let t = 0; t < 600; t++) {
    const next = selectGear(ups[0] + 0.2 * Math.sin(t * 0.3), g)
    if (next !== g) shifts++
    g = next
  }
  assert.ok(shifts <= 1, `${shifts} shifts`)
  // The result is a fixed point, whatever gear it started from.
  for (let v = 0; v < 40; v += 0.7) for (let from = 0; from < ENGINE.gears.length; from++) {
    const s = selectGear(v, from)
    assert.equal(selectGear(v, s), s)
  }
  // Plausible city cruise: 50 km/h in a middle gear at 1300–2600 rpm; reversing uses |speed|.
  const v50 = 50 / 3.6
  let gc = 0
  for (let v = 0; v <= v50; v += 0.1) gc = selectGear(v, gc)
  const rpm = engineRpm(v50, gc)
  assert.ok(rpm > 1300 && rpm < 2600, `50 km/h → ${rpm} rpm in gear ${gc + 1}`)
  near(engineRpm(-3, 0), engineRpm(3, 0), 1e-9)
  assert.ok(engineRpm(200, 0) <= ENGINE.redlineRpm)
  // Garbage gear indices are clamped, not NaN.
  assert.ok(Number.isFinite(engineRpm(10, Number.NaN)) && Number.isFinite(engineRpm(10, 99)))
})

test('engine and tyre curves: bounded, monotonic where they should be, tyres take over at speed', () => {
  assert.equal(engineLoad(-5), 0)
  assert.equal(engineLoad(10), 1)
  assert.equal(engineLoad(Number.NaN), 0)
  assert.ok(engineLoad(1) > engineLoad(0))
  for (let rpm = ENGINE.idleRpm; rpm < 6000; rpm += 100) {
    assert.ok(engineLevel(rpm + 100, 0.5) >= engineLevel(rpm, 0.5))
    assert.ok(engineLevel(rpm, 1) > engineLevel(rpm, 0))
    assert.ok(engineLevel(rpm, 1) <= 0.5 + 1e-12)
    assert.ok(engineCutoff(rpm + 100, 0.5) > engineCutoff(rpm, 0.5))
  }
  assert.equal(tyreLevel(0), 0)
  for (let v = 0; v < 40; v += 0.5) {
    assert.ok(tyreLevel(v + 0.5) >= tyreLevel(v))
    assert.ok(tyreLevel(v) <= 1.5)
    assert.ok(tyreCutoff(v) >= 380 && tyreCutoff(v) <= 2600)
  }
  const cruise = (v: number) => engineLevel(engineRpm(v, selectGear(v, 0)), 0.35)
  assert.ok(tyreLevel(20 / 3.6) < cruise(20 / 3.6), 'engine dominates at 20 km/h')
  assert.ok(tyreLevel(80 / 3.6) > cruise(80 / 3.6), 'tyres dominate at 80 km/h')
  assert.ok(carLoudness(11) > carLoudness(0), 'a moving car is louder than an idling one')
})

test('car timbre is deterministic, bounded and varied', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 64; i++) {
    const s = carTimbre(i)
    assert.equal(s, carTimbre(i))
    assert.ok(s >= 0.92 && s <= 1.08)
    seen.add(s.toFixed(3))
  }
  assert.ok(seen.size > 48)
})

test('Doppler: approaching sharpens, receding flattens, co-moving is neutral, clamped', () => {
  const v = 14
  near(dopplerFactor(0, 0, v, 0, 30, 0, 0, 0), 343 / (343 - v), 1e-12)
  near(dopplerFactor(0, 0, -v, 0, 30, 0, 0, 0), 343 / (343 + v), 1e-12)
  near(dopplerFactor(0, 0, 0, v, 30, 0, 0, 0), 1, 1e-12) // crossing at right angles
  near(dopplerFactor(0, 0, 9, 3, 30, 5, 9, 3), 1, 1e-12)
  near(dopplerFactor(0, 0, 0, 0, 30, 0, -v, 0), (343 + v) / 343, 1e-12) // listener driving toward the source
  assert.equal(dopplerFactor(5, 5, 10, 0, 5, 5, 0, 0), 1)
  assert.equal(dopplerFactor(0, 0, 300, 0, 30, 0, 0, 0), 1.25)
  assert.equal(dopplerFactor(0, 0, -300, 0, 30, 0, 0, 0), 0.8)
})

test('listener basis matches the camera (three.js YXZ Euler) and is orthonormal', () => {
  const b = new Float32Array(6)
  const rng = createRng(3)
  for (let i = 0; i < 200; i++) {
    const yaw = (rng() - 0.5) * 12, pitch = (rng() - 0.5) * 2.6
    listenerBasis(yaw, pitch, b)
    const e = new Euler(pitch, yaw, 0, 'YXZ')
    const f = new Vector3(0, 0, -1).applyEuler(e), u = new Vector3(0, 1, 0).applyEuler(e)
    near(b[0], f.x, 1e-6); near(b[1], f.y, 1e-6); near(b[2], f.z, 1e-6)
    near(b[3], u.x, 1e-6); near(b[4], u.y, 1e-6); near(b[5], u.z, 1e-6)
    near(b[0] * b[3] + b[1] * b[4] + b[2] * b[5], 0, 1e-6)
    near(Math.hypot(b[0], b[1], b[2]), 1, 1e-6)
    near(Math.hypot(b[3], b[4], b[5]), 1, 1e-6)
  }
  listenerBasis(0, 0, b)
  assert.deepEqual(Array.from(b, (x) => Math.round(x * 1e6) / 1e6 + 0), [0, 0, -1, 0, 1, 0])
})

test('murmur level: silent without people, saturating with density, quieter at night, busier while crossing', () => {
  assert.equal(murmurLevel(0, 0, 0, 1), 0)
  for (let n = 0; n < 500; n += 10) assert.ok(murmurLevel(n + 10, 10, 10, 1) > murmurLevel(n, 10, 10, 1))
  assert.ok(murmurLevel(1e6, 10, 10, 1) <= 1)
  assert.ok(murmurLevel(100, 10, 10, 0) < murmurLevel(100, 10, 10, 1) * 0.5)
  assert.ok(murmurLevel(100, 10, 10, 0) > 0, 'the night is quieter, not silent')
  assert.ok(murmurLevel(100, 0, 50, 1) > murmurLevel(100, 50, 0, 1))
  for (const bad of [Number.NaN, -5, Infinity]) assert.ok(Number.isFinite(murmurLevel(bad, bad, bad, bad === Infinity ? 1 : bad)))
})

test('murmur beds sit on sidewalks around the listener and barely move when the street choice flips', () => {
  const out = new Float32Array(8)
  const rng = createRng(11)
  const pitch = CITY.pitch
  const walkway = CITY.pitch / 2 - CITY.lotHalf
  for (let i = 0; i < 2000; i++) {
    // Anywhere a person can stand: roads and sidewalks, never inside a lot.
    let x = 0, z = 0
    do { x = 40 + rng() * 400; z = 40 + rng() * 400 } while (inLot(x, z))
    murmurLayout(x, z, out)
    for (let k = 0; k < 4; k++) {
      const px = out[k * 2], pz = out[k * 2 + 1]
      const ox = Math.abs(px - Math.round(px / pitch) * pitch), oz = Math.abs(pz - Math.round(pz / pitch) * pitch)
      const onWalk = (o: number) => o >= CITY.roadHalf - 1e-9 && o <= walkway + 1e-9
      assert.ok(onWalk(ox) || onWalk(oz), `bed ${k} at (${px.toFixed(1)}, ${pz.toFixed(1)}) is not on a sidewalk`)
      assert.ok(Math.hypot(px - x, pz - z) >= 3, 'never on top of the listener')
      assert.ok(Math.hypot(px - x, pz - z) <= 25, 'around the listener')
    }
  }
  // Mid-block on an east–west street: the beds line both sidewalks of that street.
  murmurLayout(220, 400.5, out)
  for (let k = 0; k < 4; k++) near(Math.abs(out[k * 2 + 1] - 400), CITY.lane, 1e-3)
  // Across the diagonal of an intersection the layout moves by little more than the corner geometry.
  const a = new Float32Array(8), b = new Float32Array(8)
  murmurLayout(400.3, 400.31, a)
  murmurLayout(400.31, 400.3, b)
  const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]]
  for (const layout of [a, b]) for (let k = 0; k < 4; k++) {
    const d = Math.min(...corners.map(([cx, cz]) => Math.hypot(layout[k * 2] - (400 + cx * 6.4), layout[k * 2 + 1] - (400 + cz * 6.4))))
    assert.ok(d < 1.5, `bed ${k} is ${d.toFixed(2)} m from a corner`)
  }
  for (let t = 0; t < 600; t += 0.37) for (let i = 0; i < MURMUR.sources; i++) {
    const s = murmurSwell(t, i)
    assert.ok(s >= 0.55 - 1e-9 && s <= 1 + 1e-9)
  }
})

test('voice assignment: loudest cars win, the driven car always does, no duplicates', () => {
  const slots = new Int32Array(VOICE.count).fill(-1), age = new Float32Array(VOICE.count)
  const cars = [car(0, 5, 10), car(0, 8, 10), car(0, 12, 10), car(0, 16, 10), car(0, 20, 10), car(0, 24, 10), car(0, 30, 10), car(0, 200, 10)]
  assert.equal(assignVoices(cars, 0, 0, 1 / 60, slots, age), 5)
  assert.deepEqual([...slots].sort((p, q) => p - q), [0, 1, 2, 3, 4])
  // The driven car wins a voice even when far away (it is always the camera's subject).
  cars[7] = car(0, 200, 10, 0, true)
  for (let t = 0; t < 60; t++) assignVoices(cars, 0, 0, 1 / 60, slots, age)
  assert.ok(slots.includes(7))
  assert.ok(!slots.includes(4), 'the quietest of the five gave way')
  // Beyond range nothing is voiced; empty input releases everything.
  const far = [car(500, 500, 10), car(-300, 0, 10)]
  assignVoices(far, 0, 0, 1 / 60, slots, age)
  assert.deepEqual([...slots], [-1, -1, -1, -1, -1])
  assert.equal(assignVoices([], 0, 0, 1 / 60, slots, age), 0)
  // Non-finite cars are ignored rather than voiced.
  assignVoices([car(Number.NaN, 0, 10), car(3, 3, Number.NaN), car(2, 2, 5)], 0, 0, 1 / 60, slots, age)
  assert.deepEqual([...slots].filter((s) => s >= 0), [2])
  // Cars that vanish from the list lose their voice.
  assignVoices([car(2, 2, 5), car(3, 3, 5), car(4, 4, 5)], 0, 0, 1 / 60, slots, age)
  assignVoices([car(2, 2, 5)], 0, 0, 1 / 60, slots, age)
  assert.deepEqual([...slots].filter((s) => s >= 0), [0])
})

test('voice assignment hysteresis: a held car keeps its slot, challengers must be clearly louder, min hold', () => {
  const slots = new Int32Array(2).fill(-1), age = new Float32Array(2)
  const cars = [car(0, 10, 10), car(0, 11, 10), car(0, 12, 10)]
  assignVoices(cars, 0, 0, 1 / 60, slots, age)
  const held = [...slots]
  assert.deepEqual([...held].sort(), [0, 1])
  for (let t = 0; t < 120; t++) assignVoices(cars, 0, 0, 1 / 60, slots, age)
  // Car 2 edges slightly closer than car 1: not enough to take the voice over.
  cars[2] = car(0, 10.8, 10)
  for (let t = 0; t < 120; t++) assert.equal(assignVoices(cars, 0, 0, 1 / 60, slots, age), 0)
  assert.deepEqual([...slots], held)
  // Car 2 comes much closer: it takes over car 1's slot, and car 0 stays in its own slot.
  cars[2] = car(0, 4, 10)
  assert.equal(assignVoices(cars, 0, 0, 1 / 60, slots, age), 1)
  assert.equal(slots[held.indexOf(0)], 0)
  assert.equal(slots[held.indexOf(1)], 2)
  // Just assigned: even a far louder challenger cannot take the voice within minHold.
  const one = new Int32Array([-1]), oneAge = new Float32Array(1)
  const pair = [car(0, 20, 6), car(0, 1, 14)]
  assignVoices([pair[0]], 0, 0, 1 / 60, one, oneAge)
  assert.equal(one[0], 0)
  const frames = Math.round(VOICE.minHold * 60)
  let handedAt = -1
  for (let t = 1; t <= frames + 5 && handedAt < 0; t++) {
    assignVoices(pair, 0, 0, 1 / 60, one, oneAge)
    if (one.at(0) === 1) handedAt = t
  }
  assert.ok(handedAt >= frames - 1 && handedAt <= frames + 2, `handed over after ${handedAt} frames (minHold ${frames})`)
  // New cars take idle slots before a just-released one (which still has to fade out).
  const s3 = new Int32Array([4, -1, -1]), a3 = new Float32Array([5, 0, 0])
  assert.equal(assignVoices([car(0, 3, 10), car(0, 5, 10), car(999, 0, 0), car(999, 0, 0), car(999, 0, 0)], 0, 0, 1 / 60, s3, a3), 3)
  assert.equal(s3[0], -1, 'car 4 left range and was released')
  assert.deepEqual([s3[1], s3[2]].sort(), [0, 1], 'the new cars took the idle slots')
})

test('voice assignment over a busy minute: stable slots, min hold honoured, few changes', () => {
  const rng = createRng(42)
  const n = 30
  const cars: CarSample[] = []
  const vel: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const h = rng() * Math.PI * 2, v = rng() * 13
    cars.push(car((rng() - 0.5) * 160, (rng() - 0.5) * 160, v, h, i === 5))
    vel.push([Math.sin(h) * v, Math.cos(h) * v])
  }
  const slots = new Int32Array(VOICE.count).fill(-1), age = new Float32Array(VOICE.count)
  const since = new Float64Array(VOICE.count)
  let changes = 0
  const dt = 1 / 60
  for (let f = 0; f < 3600; f++) {
    const t = f * dt
    for (let i = 0; i < n; i++) {
      const c = cars[i]
      let x = c.x + vel[i][0] * dt, z = c.z + vel[i][1] * dt
      if (Math.abs(x) > 90) { vel[i][0] *= -1; x = c.x }
      if (Math.abs(z) > 90) { vel[i][1] *= -1; z = c.z }
      cars[i] = car(x, z, c.speed, Math.atan2(vel[i][0], vel[i][1]), c.player)
    }
    const prev = [...slots]
    changes += assignVoices(cars, 10 * Math.sin(t * 0.2), 0, dt, slots, age)
    const live = [...slots].filter((s) => s >= 0)
    assert.equal(new Set(live).size, live.length, 'no car on two voices')
    assert.ok(slots.includes(5), 'the driven car always has a voice')
    for (let j = 0; j < VOICE.count; j++) {
      if (prev[j] === slots[j]) continue
      if (prev[j] >= 0 && slots.includes(prev[j])) assert.fail(`car ${prev[j]} changed slot`)
      if (prev[j] >= 0 && slots[j] >= 0) assert.ok(t - since[j] >= VOICE.minHold - 1e-6, `slot ${j} handed over after ${(t - since[j]).toFixed(2)} s`)
      since[j] = t
    }
  }
  assert.ok(changes / 60 < 2, `${(changes / 60).toFixed(2)} voice changes per second`)
})

test('engine wave: the firing order dominates; phases spread; no DC', () => {
  const { real, imag } = engineWave()
  assert.equal(real.length, ENGINE.harmonics + 1)
  assert.equal(real[0], 0)
  assert.equal(imag[0], 0)
  const amp = (k: number) => Math.hypot(real[k], imag[k])
  for (let k = 1; k <= ENGINE.harmonics; k++) if (k !== 4) assert.ok(amp(4) > amp(k), `harmonic ${k}`)
  assert.ok(amp(8) > amp(6) && amp(8) > amp(7), 'second firing harmonic above its neighbours')
  let aligned = 0
  for (let k = 1; k <= 16; k++) if (Math.abs(real[k]) < 1e-9) aligned++
  assert.ok(aligned < 4, 'phases are spread, not all sines')
})

test('noise buffer: bounded, zero-mean, deterministic', () => {
  const a = new Float32Array(48000), b = new Float32Array(48000)
  renderNoise(a, 9)
  renderNoise(b, 9)
  assert.deepEqual(a, b)
  let sum = 0
  for (const x of a) { assert.ok(x >= -1 && x < 1); sum += x }
  near(sum / a.length, 0, 0.01)
})

test('babble: speech-band, syllabic amplitude modulation, loops without a click, renders in small steps', () => {
  const out = new Float32Array(SYNTH_RATE * MURMUR.seconds)
  const job = new BabbleRender(out, SYNTH_RATE, 0xb4bb1e)
  const steps: number[] = []
  let finished = false
  while (!finished) {
    const t0 = performance.now()
    finished = job.step()
    steps.push(performance.now() - t0)
  }
  // Half a second of voiced talker audio per step (pauses cost nothing): many steps, each far below a frame.
  assert.ok(steps.length > MURMUR.talkers * MURMUR.seconds, `${steps.length} steps`)
  assert.ok(job.done && job.step(), 'stays done')
  const ms = steps.reduce((a, b) => a + b, 0)
  const sorted = [...steps].sort((a, b) => a - b)
  const p95 = sorted[Math.floor(sorted.length * 0.95)]
  // Relative, not wall-clock: under machine load every step slows alike, but no step may carry a big share.
  assert.ok(p95 < ms / 8, `p95 step ${p95.toFixed(2)} ms of ${ms.toFixed(1)} ms total`)
  const again = new Float32Array(out.length)
  renderBabble(again, SYNTH_RATE, 0xb4bb1e)
  assert.deepEqual(again, out, 'stepped and one-shot renders are identical')
  let sum = 0, peak = 0, diffSum = 0
  for (let i = 0; i < out.length; i++) {
    assert.ok(Number.isFinite(out[i]))
    sum += out[i] * out[i]
    peak = Math.max(peak, Math.abs(out[i]))
    if (i > 0) diffSum += Math.abs(out[i] - out[i - 1])
  }
  const rms = Math.sqrt(sum / out.length)
  assert.ok(peak <= 0.95 + 1e-6, `peak ${peak}`)
  assert.ok(rms > 0.1 && rms <= 0.2 + 1e-6, `rms ${rms}`)
  const seam = Math.abs(out[0] - out[out.length - 1])
  assert.ok(seam < 4 * (diffSum / (out.length - 1)), `seam step ${seam}`)
  const band = (fs: number[]) => fs.reduce((s, f) => s + power(out, SYNTH_RATE, f), 0) / fs.length
  const speech = band([450, 700, 1000, 1400, 1900])
  assert.ok(speech > 30 * band([30, 45, 60]), 'little below the voice range')
  assert.ok(speech > 30 * band([7000, 8500, 10000]), 'little above the speech band')
  // Syllables and pauses: 50 ms window levels vary (a steady hiss would not).
  const win = Math.round(SYNTH_RATE * 0.05)
  const levels: number[] = []
  for (let i = 0; i + win <= out.length; i += win) {
    let e = 0
    for (let k = i; k < i + win; k++) e += out[k] * out[k]
    levels.push(Math.sqrt(e / win))
  }
  const mean = levels.reduce((s, x) => s + x, 0) / levels.length
  const sd = Math.sqrt(levels.reduce((s, x) => s + (x - mean) ** 2, 0) / levels.length)
  assert.ok(sd / mean > 0.2, `envelope variation ${(sd / mean).toFixed(2)}`)
  console.log(`# babble: ${ms.toFixed(1)} ms total in ${steps.length} steps, p95 ${p95.toFixed(2)} ms, max ${sorted[sorted.length - 1].toFixed(2)} ms (${MURMUR.seconds} s at ${SYNTH_RATE} Hz), rms ${rms.toFixed(3)}, envelope CV ${(sd / mean).toFixed(2)}`)
})

test('walk tones: one loop per period, silent at the loop point, distinct and gentle', () => {
  for (const axis of ['ew', 'ns'] as const) {
    const out = new Float32Array(signalToneLength(axis, SYNTH_RATE))
    assert.equal(out.length, Math.round(APS[axis].period * SYNTH_RATE))
    renderSignalTone(axis, SYNTH_RATE, out)
    near(out[0], 0, 1e-6)
    near(out[out.length - 1], 0, 1e-6)
    let peak = 0, step = 0, silent = 0
    for (let i = 0; i < out.length; i++) {
      peak = Math.max(peak, Math.abs(out[i]))
      if (i > 0) step = Math.max(step, Math.abs(out[i] - out[i - 1]))
      if (out[i] === 0) silent++
    }
    assert.ok(peak <= APS[axis].amplitude + 1e-6 && peak > 0.2, `${axis} peak ${peak}`)
    // Smooth: no sample step larger than the steepest sine the notes contain.
    const fMax = Math.max(...APS[axis].notes.map((n) => Math.max(n[2], n[3])))
    assert.ok(step <= (2 * Math.PI * 2 * fMax * APS[axis].amplitude) / SYNTH_RATE, `${axis} step ${step}`)
    assert.ok(silent / out.length > 0.5, 'mostly silence between notes')
  }
  const ns = new Float32Array(signalToneLength('ns', SYNTH_RATE)), ew = new Float32Array(signalToneLength('ew', SYNTH_RATE))
  renderSignalTone('ns', SYNTH_RATE, ns)
  renderSignalTone('ew', SYNTH_RATE, ew)
  const span = (s: number, l: number) => [Math.round(s * SYNTH_RATE), Math.round((s + l) * SYNTH_RATE)] as const
  const [a0, a1] = span(0, 0.2), [b0, b1] = span(0.3, 0.26)
  assert.ok(power(ns, SYNTH_RATE, 1100, a0, a1) > 20 * power(ns, SYNTH_RATE, 880, a0, a1), 'cuckoo: high note first')
  assert.ok(power(ns, SYNTH_RATE, 880, b0, b1) > 20 * power(ns, SYNTH_RATE, 1100, b0, b1), 'cuckoo: then the low note')
  const [c0, c1] = span(0, 0.09)
  const sweep = [2100, 2400, 2700].reduce((s, f) => s + power(ew, SYNTH_RATE, f, c0, c1), 0)
  assert.ok(sweep > 20 * power(ew, SYNTH_RATE, 1000, c0, c1), 'chirp: a high sweep')
  assert.ok(power(ew, SYNTH_RATE, 1100, c0, c1) < power(ns, SYNTH_RATE, 1100, a0, a1) / 20, 'the two axes sound different')
})

// ---------------------------------------------------------------------------- Soundscape on a fake graph

interface Ev { kind: 'target' | 'set' | 'cancel'; v: number; t: number; tau?: number }

/** WebIDL `float`: a double that rounds past the single-precision range throws, like NaN and ±Infinity. */
const FLOAT_MAX = 3.4028234663852886e38
const float = (v: number) => {
  if (!Number.isFinite(v) || Math.abs(v) > FLOAT_MAX) throw new TypeError('The provided float value is non-finite.')
}

class FakeParam {
  value: number
  automationRate: 'a-rate' | 'k-rate' = 'a-rate'
  readonly events: Ev[] = []
  constructor(v: number) { this.value = v }
  /** The value the automation is heading for. */
  get target(): number {
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i].kind !== 'cancel') return this.events[i].v
    return this.value
  }
  setTargetAtTime(v: number, t: number, tau: number) {
    float(v); float(tau)
    if (!Number.isFinite(t)) throw new TypeError('The provided double value is non-finite.')
    if (t < 0 || tau < 0) throw new RangeError('negative time')
    this.events.push({ kind: 'target', v, t, tau })
    return this
  }
  setValueAtTime(v: number, t: number) {
    float(v)
    if (!Number.isFinite(t)) throw new TypeError('The provided double value is non-finite.')
    if (t < 0) throw new RangeError('negative time')
    this.events.push({ kind: 'set', v, t })
    this.value = v
    return this
  }
  cancelScheduledValues(t: number) {
    if (!Number.isFinite(t) || t < 0) throw new RangeError('bad time')
    this.events.push({ kind: 'cancel', v: Number.NaN, t })
    return this
  }
}

class FakeNode {
  readonly ctx: FakeContext
  readonly outputs: FakeNode[] = []
  constructor(ctx: FakeContext) { this.ctx = ctx; ctx.nodes.push(this) }
  connect(n: FakeNode): undefined {
    this.outputs.push(n)
    return undefined // older WebKit returns nothing: chains must not be relied on
  }
  disconnect() { this.outputs.length = 0 }
}
class FakeGain extends FakeNode { gain = new FakeParam(1) }
class FakeBiquad extends FakeNode { type = 'lowpass'; frequency = new FakeParam(350); Q = new FakeParam(1) }
class FakeCompressor extends FakeNode { threshold = new FakeParam(-24); knee = new FakeParam(30); ratio = new FakeParam(12) }
class FakePanner extends FakeNode {
  panningModel = 'equalpower'; distanceModel = 'inverse'; refDistance = 1; rolloffFactor = 1; maxDistance = 10000
  positionX = new FakeParam(0); positionY = new FakeParam(0); positionZ = new FakeParam(0)
}
class FakeSource extends FakeNode {
  started = -1; offset = 0; stopped = -1
  onended: (() => void) | null = null
  start(when = 0, offset = 0) {
    if (this.started >= 0) throw new Error('InvalidStateError: start twice')
    this.started = when; this.offset = offset
  }
  stop(when = 0) {
    if (this.started < 0) throw new Error('InvalidStateError: stop before start')
    this.stopped = when
  }
}
class FakeOsc extends FakeSource { frequency = new FakeParam(440); wave: unknown = null; setPeriodicWave(w: unknown) { this.wave = w } }
class FakeBufferSource extends FakeSource { buffer: FakeBuffer | null = null; loop = false; playbackRate = new FakeParam(1) }
class FakeBuffer {
  readonly data: Float32Array; readonly length: number; readonly sampleRate: number
  constructor(len: number, rate: number) {
    if (rate < 22050) throw new Error('NotSupportedError: older WebKit rejects low buffer rates')
    this.data = new Float32Array(len); this.length = len; this.sampleRate = rate
  }
  get duration() { return this.length / this.sampleRate }
  getChannelData() { return this.data }
}
class ParamListener {
  positionX = new FakeParam(0); positionY = new FakeParam(0); positionZ = new FakeParam(0)
  forwardX = new FakeParam(0); forwardY = new FakeParam(0); forwardZ = new FakeParam(-1)
  upX = new FakeParam(0); upY = new FakeParam(1); upZ = new FakeParam(0)
}
class LegacyListener {
  readonly positions: number[][] = []
  readonly orientations: number[][] = []
  setPosition(x: number, y: number, z: number) { float(x); float(y); float(z); this.positions.push([x, y, z]) }
  setOrientation(...v: number[]) { v.forEach(float); this.orientations.push(v) }
}
/** A panner without position AudioParams (older engines): only setPosition(). */
class LegacyPanner extends FakeNode {
  panningModel = 'equalpower'; distanceModel = 'inverse'; refDistance = 1; rolloffFactor = 1; maxDistance = 10000
  readonly positions: number[][] = []
  setPosition(x: number, y: number, z: number) { float(x); float(y); float(z); this.positions.push([x, y, z]) }
}

/** A convolver (the room's tail), present only when FakeContext.reverb is set: the default graph stays dry. */
class FakeConvolver extends FakeNode { buffer: FakeBuffer | null = null; normalize = true }
/** A MediaStream source (a peer's voice), present only when FakeContext.streams is set. */
class FakeStreamSource extends FakeNode {
  readonly stream: unknown
  constructor(ctx: FakeContext, stream: unknown) { super(ctx); this.stream = stream }
}

class FakeContext {
  static instances: FakeContext[] = []
  static legacy = false
  static legacyPanners = false
  /** Newer engines only: a ConvolverNode, a MediaStreamAudioSourceNode. Off by default, so every existing count is exact. */
  static reverb = false
  static streams = false
  state: 'suspended' | 'running' | 'closed' | 'interrupted' = 'suspended'
  currentTime = 0
  readonly sampleRate = 48000
  readonly nodes: FakeNode[] = []
  readonly destination: FakeNode
  readonly listener: ParamListener | LegacyListener
  readonly calls: string[] = []
  readonly options: unknown
  createConvolver?: () => FakeConvolver
  createMediaStreamSource?: (stream: unknown) => FakeStreamSource
  constructor(options?: unknown) {
    FakeContext.instances.push(this)
    this.options = options
    this.destination = new FakeNode(this)
    this.listener = FakeContext.legacy ? new LegacyListener() : new ParamListener()
    if (FakeContext.reverb) this.createConvolver = () => new FakeConvolver(this)
    if (FakeContext.streams) this.createMediaStreamSource = (stream: unknown) => new FakeStreamSource(this, stream)
  }
  resume() { this.calls.push('resume'); if (this.state !== 'closed') this.state = 'running'; return Promise.resolve() }
  suspend() { this.calls.push('suspend'); if (this.state !== 'closed') this.state = 'suspended'; return Promise.resolve() }
  close() { this.calls.push('close'); this.state = 'closed'; return Promise.resolve() }
  createGain() { return new FakeGain(this) }
  createBiquadFilter() { return new FakeBiquad(this) }
  createDynamicsCompressor() { return new FakeCompressor(this) }
  createPanner() { return FakeContext.legacyPanners ? new LegacyPanner(this) : new FakePanner(this) }
  createOscillator() { return new FakeOsc(this) }
  createBufferSource() { return new FakeBufferSource(this) }
  createBuffer(_channels: number, len: number, rate: number) { return new FakeBuffer(len, rate) }
  /** Every buffer decoded (the bytes given, which the real call detaches); fewer than 44 bytes is not audio. */
  readonly decoded: ArrayBuffer[] = []
  decodeAudioData(bytes: ArrayBuffer) {
    this.decoded.push(bytes)
    if (bytes.byteLength < 44) return Promise.reject(new DOMException('Unable to decode audio data', 'EncodingError'))
    return Promise.resolve(new FakeBuffer((bytes.byteLength - 44) / 2, 24000))
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array) {
    assert.equal(real.length, imag.length)
    return { real, imag }
  }
  of<T extends FakeNode>(type: new (ctx: FakeContext, ...rest: never[]) => T): T[] {
    return this.nodes.filter((n): n is T => n instanceof type)
  }
}

interface FakeDocument extends EventTarget { hidden: boolean }

const g = globalThis as unknown as Record<string, unknown>

function withFakes(fn: (doc: FakeDocument) => void | Promise<void>, legacy = false): () => Promise<void> {
  return async () => {
    const saved = { AudioContext: g.AudioContext, PannerNode: g.PannerNode, document: g.document }
    FakeContext.instances = []
    FakeContext.legacy = legacy
    const doc = Object.assign(new EventTarget(), { hidden: false })
    g.AudioContext = FakeContext
    g.PannerNode = FakePanner
    g.document = doc
    try { await fn(doc) } finally {
      g.AudioContext = saved.AudioContext
      g.PannerNode = saved.PannerNode
      g.document = saved.document
      FakeContext.legacy = false
      FakeContext.legacyPanners = false
      FakeContext.reverb = false
      FakeContext.streams = false
    }
  }
}

interface VoiceView {
  car: number; fading: boolean
  pan: { node: FakePanner }
  freq: { param: FakeParam }; engineGain: { param: FakeParam }; tyreGain: { param: FakeParam }; engineCut: { param: FakeParam }
}
interface GraphView {
  babbleJob: unknown
  voices: VoiceView[]; beds: { gain: { param: FakeParam }; pan: { node: FakePanner } }[]
  cabin: { param: FakeParam }; master: { param: FakeParam }
  tones: Record<'ew' | 'ns', { gain: FakeGain; source: FakeBufferSource | null; envelope: FakeGain | null; on: boolean }>
  tonePan: { node: FakePanner }
}
const graphOf = (s: Soundscape) => (s as unknown as { graph: GraphView }).graph
const ctxOf = () => FakeContext.instances[FakeContext.instances.length - 1]

function frame(over: Partial<AudioFrame> = {}): AudioFrame {
  return {
    dt: 1 / 60,
    listener: { x: 200, y: 1.7, z: 205, yaw: 0, pitch: 0 },
    cars: [],
    crowd: { near: 80, waiting: 40, crossing: 20 },
    daylight: 1,
    walk: { ew: false, ns: false },
    intersection: { x: 200, z: 200 },
    interior: false,
    ...over,
  }
}

/** Advances the fake audio clock and runs one control pass. */
function tick(s: Soundscape, f: AudioFrame, seconds = f.dt): void {
  ctxOf().currentTime += seconds
  s.update(f)
}

test('without Web Audio the soundscape is inert and says so', () => {
  assert.equal(typeof g.AudioContext, 'undefined', 'Node has no Web Audio')
  const s = new Soundscape()
  assert.deepEqual(s.status(), { state: 'unsupported', voices: 0, hrtf: false, volume: 0.8 })
  s.unlock()
  s.update(frame({ cars: [car(200, 210, 10)] }))
  s.setEnabled(false)
  s.setVolume(0.3)
  s.dispose()
  assert.equal(s.status().state, 'unsupported')
})

test('nothing is created before the gesture; unlock builds one HRTF graph and is idempotent', withFakes(() => {
  const s = new Soundscape()
  assert.equal(s.status().state, 'locked')
  s.update(frame({ cars: [car(200, 210, 10)] }))
  assert.equal(FakeContext.instances.length, 0, 'no AudioContext before a user gesture')
  s.unlock()
  s.unlock()
  assert.equal(FakeContext.instances.length, 1)
  const ctx = ctxOf()
  assert.deepEqual(ctx.options, { latencyHint: 'balanced' })
  assert.deepEqual(s.status(), { state: 'running', voices: 0, hrtf: true, volume: 0.8 })
  const panners = ctx.of(FakePanner)
  assert.equal(panners.length, VOICE.count + MURMUR.sources + 1 + CUE.slots + 1, 'cars, beds, walk tones, cues, speech')
  for (const p of panners) { assert.equal(p.panningModel, 'HRTF'); assert.equal(p.distanceModel, 'inverse') }
  assert.equal(ctx.of(FakeOsc).length, VOICE.count)
  for (const o of ctx.of(FakeOsc)) assert.ok(o.started >= 0 && o.wave !== null)
  assert.equal(ctx.of(FakeBufferSource).length, VOICE.count, 'the babble renders after the gesture, not inside it')
  // One babble chunk per control pass, then the beds start looping the finished buffer.
  let passes = 0
  while (graphOf(s).babbleJob) {
    assert.equal(ctx.of(FakeBufferSource).length, VOICE.count)
    tick(s, frame())
    passes++
    assert.ok(passes < 1000, 'babble never finished')
  }
  assert.ok(passes > 20, `spread over ${passes} frames`)
  const loops = ctx.of(FakeBufferSource)
  assert.equal(loops.length, VOICE.count + MURMUR.sources, 'tone sources are made per walk phase, not up front')
  const beds = loops.slice(VOICE.count)
  const expected = new Float32Array(SYNTH_RATE * MURMUR.seconds)
  renderBabble(expected, SYNTH_RATE, 0xb4bb1e)
  for (const b of beds) assert.deepEqual(b.buffer!.data, expected)
  assert.equal(new Set(beds.map((b) => b.playbackRate.value)).size, MURMUR.sources, 'beds drift against each other')
  assert.equal(s.status().voices, MURMUR.sources)
  for (const b of loops) {
    assert.ok(b.loop && b.started >= 0 && b.buffer !== null)
    assert.ok(b.offset >= 0 && b.offset < b.buffer!.length / b.buffer!.sampleRate, 'start offset inside the buffer')
  }
  // Everything reaches the destination through cabin filter → master → limiter.
  const reaches = (n: FakeNode, seen = new Set<FakeNode>()): boolean => n === ctx.destination || (!seen.has(n) && (seen.add(n), n.outputs.some((o) => reaches(o, seen))))
  for (const n of [...panners, ...ctx.of(FakeOsc), ...loops]) assert.ok(reaches(n), `${n.constructor.name} is not connected`)
  s.dispose()
}))

test('murmur beds swell in from silence when their loops start (no click at mid-waveform offsets)', withFakes(() => {
  const s = new Soundscape()
  s.unlock()
  const ctx = ctxOf()
  // The crowd is busy from the first frame, so the bed gains follow it while the babble still renders.
  while (graphOf(s).babbleJob) tick(s, frame())
  const gv = graphOf(s)
  const loops = ctx.of(FakeBufferSource).slice(VOICE.count)
  assert.equal(loops.length, MURMUR.sources)
  for (let i = 0; i < MURMUR.sources; i++) {
    const events = gv.beds[i].gain.param.events
    const start = loops[i].started
    const k = events.findIndex((e) => e.kind === 'set')
    assert.ok(k >= 0, `bed ${i} gain is not reset when its loop starts`)
    assert.equal(events[k].v, 0)
    near(events[k].t, start, 1e-9, 'reset at the loop start')
    assert.ok(events.slice(0, k).some((e) => e.kind === 'target' && e.v > 0.01), 'the gain was up before the loop existed')
    const after = events.slice(k + 1)
    assert.ok(after.length > 0 && after.every((e) => e.kind === 'target'), 'then it only glides')
    assert.ok(after[0].tau! >= 0.2 && after[0].v > 0, 'a slow swell')
  }
  s.dispose()
}))

test('cars are voiced where they are, at the gearbox pitch, and the listener follows the camera', withFakes(() => {
  const s = new Soundscape()
  s.unlock()
  while (graphOf(s).babbleJob) tick(s, frame())
  const cars = [car(210, 205, 11, Math.PI / 2), car(200, 600, 10), car(195, 195, 0, Math.PI)]
  const listener = { x: 200, y: 1.7, z: 205, yaw: 0.4, pitch: -0.1 }
  for (let i = 0; i < 30; i++) tick(s, frame({ cars, listener }))
  const gv = graphOf(s)
  const voiced = gv.voices.filter((v) => v.car >= 0).map((v) => v.car).sort()
  assert.deepEqual(voiced, [0, 2], 'the far car is not voiced')
  const v = gv.voices.find((x) => x.car === 0)!
  const scale = carTimbre(0)
  let gear = 0
  gear = selectGear(11, gear, scale)
  const doppler = dopplerFactor(210 + VOICE.nose, 205, 11, 0, 200, 205, 0, 0)
  near(v.freq.param.target, engineRpm(11, gear, scale) * ENGINE.fundamental * scale * doppler, 0.01 * v.freq.param.target)
  assert.ok(doppler < 1, 'driving away from the listener: flatter')
  near(v.pan.node.positionX.target, 210 + VOICE.nose, 0.02)
  near(v.pan.node.positionY.target, VOICE.height, 1e-9)
  near(v.pan.node.positionZ.target, 205, 0.02)
  assert.ok(v.engineGain.param.target > 0 && v.tyreGain.param.target > 0)
  const idle = gv.voices.find((x) => x.car === 2)!
  const idleHz = ENGINE.idleRpm * ENGINE.fundamental * carTimbre(2)
  near(idle.freq.param.target, idleHz, idleHz * 0.006) // ±0.5 % engine wobble
  near(idle.tyreGain.param.target, 0, 1e-9)
  const l = ctxOf().listener as ParamListener
  const b = new Float32Array(6)
  listenerBasis(listener.yaw, listener.pitch, b)
  near(l.positionX.target, 200, 1e-9); near(l.positionY.target, 1.7, 1e-6); near(l.positionZ.target, 205, 1e-9)
  near(l.forwardX.target, b[0], 1e-6); near(l.forwardY.target, b[1], 1e-6); near(l.forwardZ.target, b[2], 1e-6)
  near(l.upX.target, b[3], 1e-6); near(l.upY.target, b[4], 1e-6); near(l.upZ.target, b[5], 1e-6)
  // The murmur is up in daylight with people about, on the beds' sidewalk positions.
  for (const bed of gv.beds) assert.ok(bed.gain.param.target > 0.01)
  const layout = new Float32Array(8)
  murmurLayout(200, 205, layout)
  near(gv.beds[0].pan.node.positionX.target, layout[0], 1e-6)
  near(gv.beds[0].pan.node.positionZ.target, layout[1], 1e-6)
  assert.equal(s.status().voices, 2 + MURMUR.sources)
  s.dispose()
}))

test('a reassigned voice fades out before it switches car: gains only ever jump while silent', withFakes(() => {
  const s = new Soundscape()
  s.unlock()
  const cars = [car(200, 225, 8), car(200, 228, 8), car(200, 231, 8), car(200, 234, 8), car(200, 237, 8)]
  for (let i = 0; i < 60; i++) tick(s, frame({ cars }))
  const gv = graphOf(s)
  assert.equal(gv.voices.filter((v) => v.car >= 0).length, 5)
  const outgoing = gv.voices.find((v) => v.car === 4)!
  cars.push(car(200, 207, 12))
  tick(s, frame({ cars }))
  assert.ok(outgoing.fading, 'the quietest voice starts fading')
  assert.equal(outgoing.car, 4, 'and keeps its old car until silent')
  near(outgoing.engineGain.param.target, 0, 1e-12)
  const last = outgoing.engineGain.param.events[outgoing.engineGain.param.events.length - 1]
  assert.equal(last.kind, 'target', 'a ramp, not a jump')
  tick(s, frame({ cars }), 0.05)
  assert.equal(outgoing.car, 4, 'not switched mid-fade')
  tick(s, frame({ cars }), 0.2)
  assert.equal(outgoing.car, 5, 'switched once silent')
  assert.ok(outgoing.engineGain.param.target > 0, 'and fades in on the new car')
  for (let i = 0; i < 30; i++) tick(s, frame({ cars }))
  // Click-free invariant over the whole run: every hard set of a voice gain is to zero, after ≥ 5τ of fading to zero.
  for (const v of gv.voices) for (const p of [v.engineGain.param, v.tyreGain.param]) {
    let lastTarget: Ev | null = null
    for (const e of p.events) {
      if (e.kind === 'set') {
        assert.equal(e.v, 0, 'gains only jump to silence')
        if (lastTarget && lastTarget.v !== 0) assert.fail('jumped while audible')
        if (lastTarget) assert.ok(e.t - lastTarget.t >= 5 * VOICE.fade - 1e-9, 'jumped before the fade finished')
      }
      if (e.kind === 'target') lastTarget = e
    }
  }
  s.dispose()
}))

test('inside the car: the exterior is muffled and the own engine sits ahead of the listener', withFakes(() => {
  const s = new Soundscape()
  s.unlock()
  const listener = { x: 300, y: 1.2, z: 300, yaw: Math.PI, pitch: 0 }
  const cars = [car(300, 300.5, 9, 0, true), car(310, 320, 9, Math.PI)]
  for (let i = 0; i < 20; i++) tick(s, frame({ cars, listener, interior: false }))
  const gv = graphOf(s)
  near(gv.cabin.param.target, CABIN.open, 1e-9)
  const other = gv.voices.find((v) => v.car === 1)!
  const outsideGain = other.engineGain.param.target
  for (let i = 0; i < 20; i++) tick(s, frame({ cars, listener, interior: true }))
  near(gv.cabin.param.target, CABIN.cutoff, 1e-9)
  near(other.engineGain.param.target, outsideGain * CABIN.outside, outsideGain * 0.05)
  const own = gv.voices.find((v) => v.car === 0)!
  near(own.pan.node.positionX.target, 300, 0.02)
  near(own.pan.node.positionZ.target, 300 + CABIN.engineBay, 0.02)
  // Co-moving with the listener: no Doppler on the own engine.
  const scale = carTimbre(0)
  near(own.freq.param.target, engineRpm(9, selectGear(9, 0, scale), scale) * ENGINE.fundamental * scale, 0.01 * own.freq.param.target)
  // Doppler on the other car uses the driven car's velocity as the listener's.
  const ox = 310 + Math.sin(Math.PI) * VOICE.nose, oz = 320 + Math.cos(Math.PI) * VOICE.nose
  const expected = dopplerFactor(ox, oz, Math.sin(Math.PI) * 9, Math.cos(Math.PI) * 9, 300, 300, 0, 9)
  assert.ok(expected > 1.04, 'closing at 18 m/s')
  const s1 = carTimbre(1)
  near(other.freq.param.target, engineRpm(9, selectGear(9, 0, s1), s1) * ENGINE.fundamental * s1 * expected, 0.01 * other.freq.param.target)
  s.dispose()
}))

test('walk tones: a fresh loop per walk phase at the intersection, stopped with a fade', withFakes(() => {
  const s = new Soundscape()
  s.unlock()
  const gv = graphOf(s)
  const ctx = ctxOf()
  while (graphOf(s).babbleJob) tick(s, frame())
  tick(s, frame({ walk: { ew: false, ns: true }, intersection: { x: 240, z: 200 } }))
  const t = gv.tones.ns
  assert.ok(t.on && t.source)
  const src = t.source!
  assert.equal(src.loop, true)
  assert.equal(src.buffer!.length, signalToneLength('ns', SYNTH_RATE))
  assert.ok(src.started > ctx.currentTime - 1e-9)
  near(t.gain.gain.target, APS.level, 1e-9)
  const env = t.envelope!
  assert.ok(src.outputs.includes(env) && env.outputs.includes(t.gain), 'source → phase envelope → shared level')
  near(env.gain.value, 1, 1e-12)
  near(gv.tonePan.node.positionX.target, 240, 1e-9)
  near(gv.tonePan.node.positionY.target, APS.height, 1e-9)
  assert.equal(gv.tones.ew.on, false)
  assert.equal(s.status().voices, MURMUR.sources + 1)
  for (let i = 0; i < 10; i++) tick(s, frame({ walk: { ew: false, ns: true } }))
  assert.equal(t.source, src, 'one source per phase')
  tick(s, frame({ walk: { ew: false, ns: false } }))
  assert.equal(t.on, false)
  assert.ok(src.stopped > ctx.currentTime, 'stops after the fade')
  const lastEv = env.gain.events[env.gain.events.length - 1]
  assert.equal(lastEv.kind, 'target')
  assert.equal(lastEv.v, 0)
  assert.ok((src.stopped - lastEv.t) / lastEv.tau! >= 7, 'the tail is silent (≤ −60 dB) before it stops')
  tick(s, frame({ walk: { ew: true, ns: false } }))
  assert.ok(gv.tones.ew.on && gv.tones.ew.source !== src)
  assert.equal(gv.tones.ew.source!.buffer!.length, signalToneLength('ew', SYNTH_RATE))
  s.dispose()
}))

test('walk tones: a phase restarting inside the previous tail neither revives nor cuts it', withFakes(() => {
  const s = new Soundscape()
  s.unlock()
  const gv = graphOf(s)
  const t = gv.tones.ns
  tick(s, frame({ walk: { ew: false, ns: true } }))
  const first = t.source!, firstEnv = t.envelope!
  tick(s, frame({ walk: { ew: false, ns: false } }))
  // A clock jump turns the same walk phase back on 0.1 s later, while the first loop is still fading.
  tick(s, frame({ walk: { ew: false, ns: true } }), 0.1)
  assert.ok(t.on && t.source !== first && t.envelope !== firstEnv, 'a new loop on its own envelope')
  assert.ok(first.stopped > ctxOf().currentTime, 'the old tail keeps fading until its stop')
  const tail = firstEnv.gain.events
  assert.equal(tail.length, 1)
  assert.equal(tail[0].kind, 'target')
  assert.equal(tail[0].v, 0)
  for (let i = 0; i < 20; i++) tick(s, frame({ walk: { ew: false, ns: true } }))
  assert.equal(firstEnv.gain.events.length, 1, 'nothing brings the fading tail back up')
  // The shared level never jumps and never drops to silence: it only follows the cabin muffling.
  for (const e of t.gain.gain.events) { assert.equal(e.kind, 'target'); assert.ok(e.v > 0) }
  s.dispose()
}))

test('legacy listener API is used where AudioListener has no AudioParams', withFakes(() => {
  const s = new Soundscape()
  s.unlock()
  const l = ctxOf().listener as LegacyListener
  assert.ok(l instanceof LegacyListener)
  tick(s, frame({ listener: { x: 10, y: 2, z: 20, yaw: 0, pitch: 0 } }))
  assert.deepEqual(l.positions.at(-1), [10, 2, 20])
  assert.deepEqual(l.orientations.at(-1)!.map((x) => Math.round(x * 1e6) / 1e6 + 0), [0, 0, -1, 0, 1, 0])
  const [np, no] = [l.positions.length, l.orientations.length]
  tick(s, frame({ listener: { x: 10.001, y: 2, z: 20, yaw: 0, pitch: 0 } }))
  assert.equal(l.positions.length, np, 'dead-banded')
  assert.equal(l.orientations.length, no, 'dead-banded')
  tick(s, frame({ listener: { x: 12, y: 2, z: 20, yaw: 1, pitch: 0 } }))
  assert.equal(l.positions.length, np + 1)
  assert.equal(l.orientations.length, no + 1)
  s.dispose()
}, true))

test('legacy panners (no position AudioParams) are placed through setPosition()', withFakes(() => {
  FakeContext.legacyPanners = true
  const s = new Soundscape()
  s.unlock()
  const ctx = ctxOf()
  const panners = ctx.of(LegacyPanner)
  assert.equal(panners.length, VOICE.count + MURMUR.sources + 1 + CUE.slots + 1, 'cars, beds, walk tones, cues, speech')
  const cars = [car(210, 205, 8, Math.PI / 2)]
  for (let i = 0; i < 5; i++) tick(s, frame({ cars, walk: { ew: true, ns: false }, intersection: { x: 240, z: 200 } }))
  const gv = graphOf(s) as unknown as { voices: { car: number; pan: { node: LegacyPanner } }[]; beds: { pan: { node: LegacyPanner } }[]; tonePan: { node: LegacyPanner } }
  const voice = gv.voices.find((v) => v.car === 0)!
  // Every panner that sounds has been placed (idle car voices are silent and need no position).
  for (const p of [voice.pan.node, ...gv.beds.map((b) => b.pan.node), gv.tonePan.node]) assert.ok(p.positions.length >= 1, 'placed')
  const at = voice.pan.node.positions.at(-1)!
  near(at[0], 210 + VOICE.nose, 0.02); near(at[1], VOICE.height, 1e-9); near(at[2], 205, 0.02)
  assert.deepEqual(gv.tonePan.node.positions.at(-1), [240, APS.height, 200])
  const layout = new Float32Array(8)
  murmurLayout(200, 205, layout)
  near(gv.beds[1].pan.node.positions.at(-1)![0], layout[2], 1e-4)
  // Dead-banded: a car creeping 1 mm does not call setPosition again.
  const n = voice.pan.node.positions.length
  cars[0] = car(210.001, 205, 0, Math.PI / 2)
  tick(s, frame({ cars }))
  assert.equal(voice.pan.node.positions.length, n)
  s.dispose()
}))

test('automation that needs no sample accuracy runs at k-rate; gains stay a-rate for smooth fades', withFakes(() => {
  const s = new Soundscape()
  s.unlock()
  const ctx = ctxOf()
  for (const p of ctx.of(FakePanner)) for (const q of [p.positionX, p.positionY, p.positionZ]) assert.equal(q.automationRate, 'k-rate')
  const l = ctx.listener as ParamListener
  for (const q of [l.positionX, l.positionY, l.positionZ, l.forwardX, l.forwardY, l.forwardZ, l.upX, l.upY, l.upZ]) assert.equal(q.automationRate, 'k-rate')
  for (const f of ctx.of(FakeBiquad)) assert.equal(f.frequency.automationRate, 'k-rate')
  for (const o of ctx.of(FakeOsc)) assert.equal(o.frequency.automationRate, 'k-rate')
  for (const gn of ctx.of(FakeGain)) assert.equal(gn.gain.automationRate, 'a-rate')
  s.dispose()
}))

test('the listener jumps on a camera cut instead of sweeping its forward vector through zero', withFakes(() => {
  const s = new Soundscape()
  s.unlock()
  const l = ctxOf().listener as ParamListener
  const fwd = [l.forwardX, l.forwardY, l.forwardZ, l.upX, l.upY, l.upZ]
  const lastKind = (p: FakeParam) => p.events[p.events.length - 1].kind
  tick(s, frame({ listener: { x: 200, y: 1.7, z: 205, yaw: 0, pitch: 0 } }))
  assert.equal(lastKind(l.positionX), 'set', 'the first pass places the listener, no sweep in from the origin')
  assert.equal(lastKind(l.forwardZ), 'set')
  tick(s, frame({ listener: { x: 200.5, y: 1.7, z: 205, yaw: 0.05, pitch: 0 } }))
  assert.equal(lastKind(l.positionX), 'target', 'ordinary motion glides')
  assert.equal(lastKind(l.forwardX), 'target')
  // Entering a car: the chase camera swings round by ~180° in one frame.
  tick(s, frame({ listener: { x: 200.5, y: 1.7, z: 205, yaw: 0.05 + Math.PI * 0.97, pitch: 0 } }))
  for (const p of fwd) assert.equal(lastKind(p), 'set')
  near(l.forwardZ.value, -Math.cos(0.05 + Math.PI * 0.97), 1e-6)
  tick(s, frame({ listener: { x: 200.5, y: 1.7, z: 205, yaw: 0.1 + Math.PI * 0.97, pitch: 0 } }))
  assert.equal(lastKind(l.forwardX), 'target', 'and glides again afterwards')
  s.dispose()
}))

test('values beyond single-float range never reach Web Audio (WebIDL float would throw)', withFakes(() => {
  const s = new Soundscape()
  s.unlock()
  const huge = 1e39
  assert.doesNotThrow(() => {
    for (let i = 0; i < 5; i++) {
      tick(s, frame({ cars: [car(huge, 205, 10, 0, true), car(201, 206, 8)], interior: false }))
      tick(s, frame({ cars: [car(200, -huge, 10, 0, true)], interior: true }))
      tick(s, frame({ listener: { x: huge, y: 1.7, z: 205, yaw: 0, pitch: 0 } }))
      tick(s, frame({ intersection: { x: huge, z: 200 }, walk: { ew: true, ns: false } }))
    }
  })
  assert.equal(s.status().state, 'running', 'handled by the guards, not by the failure path')
  s.dispose()
}))

test('an audio stack that throws mid-frame is switched off instead of breaking the frame loop', withFakes(() => {
  const s = new Soundscape()
  s.unlock()
  const ctx = ctxOf()
  tick(s, frame({ cars: [car(200, 210, 10)] }))
  const gv = graphOf(s)
  const v = gv.voices.find((x) => x.car === 0)!
  v.freq.param.setTargetAtTime = () => { throw new Error('InvalidStateError: something unforeseen') }
  assert.doesNotThrow(() => tick(s, frame({ cars: [car(200, 211, 12)] }), 0.05))
  assert.equal(s.status().state, 'unsupported')
  assert.equal(ctx.state, 'closed')
  for (const src of [...ctx.of(FakeOsc), ...ctx.of(FakeBufferSource)]) assert.ok(src.stopped >= 0)
  assert.doesNotThrow(() => { s.update(frame()); s.unlock(); s.setEnabled(true); s.setVolume(0.5) })
  assert.equal(FakeContext.instances.length, 1, 'no new context after the failure')
  s.dispose()
}))

test('disabled before the first gesture: the context is created but kept asleep', withFakes(() => {
  const s = new Soundscape()
  s.setEnabled(false)
  s.unlock()
  assert.equal(ctxOf().state, 'suspended')
  assert.equal(s.status().state, 'off')
  near(graphOf(s).master.param.value, 0, 1e-12)
  s.setEnabled(true)
  assert.equal(ctxOf().state, 'running')
  near(graphOf(s).master.param.target, volumeToGain(0.8) * 2, 1e-9)
  s.dispose()
}))

test('volume, enable/disable and page visibility', withFakes(async (doc) => {
  const s = new Soundscape()
  s.setVolume(0.5)
  s.unlock()
  const gv = graphOf(s)
  const ctx = ctxOf()
  near(ctx.of(FakeGain).length > 0 ? gv.master.param.value : 0, volumeToGain(0.5) * 2, 1e-9)
  s.setVolume(2)
  assert.equal(s.status().volume, 1)
  near(gv.master.param.target, 2, 1e-9)
  s.setEnabled(false)
  assert.equal(s.status().state, 'off')
  near(gv.master.param.target, 0, 1e-12)
  const before = ctx.of(FakePanner).reduce((n, p) => n + p.positionX.events.length, 0)
  tick(s, frame({ cars: [car(200, 210, 10)] }))
  assert.equal(ctx.of(FakePanner).reduce((n, p) => n + p.positionX.events.length, 0), before, 'no work while off')
  await new Promise((r) => setTimeout(r, 350))
  assert.equal(ctx.state, 'suspended', 'the context sleeps once faded out')
  s.setEnabled(true)
  assert.equal(s.status().state, 'running')
  near(gv.master.param.target, 2, 1e-9)
  doc.hidden = true
  doc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(ctx.state, 'suspended')
  assert.equal(s.status().state, 'suspended')
  s.unlock()
  assert.equal(ctx.state, 'suspended', 'a hidden page stays asleep')
  doc.hidden = false
  doc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(ctx.state, 'running')
  // Re-enabling right after disabling cancels the pending suspend.
  s.setEnabled(false)
  s.setEnabled(true)
  await new Promise((r) => setTimeout(r, 350))
  assert.equal(ctx.state, 'running')
  // An interrupted context (iOS call) reads as suspended until the next gesture resumes it.
  ctx.state = 'interrupted'
  assert.equal(s.status().state, 'suspended')
  s.unlock()
  assert.equal(ctx.state, 'running')
  s.dispose()
}))

test('non-finite input never reaches an AudioParam; the control pass is rate-limited', withFakes(() => {
  const s = new Soundscape()
  s.unlock()
  const bad = Number.NaN
  assert.doesNotThrow(() => {
    for (let i = 0; i < 10; i++) {
      tick(s, frame({ cars: [car(bad, 200, 10), car(201, 206, bad), car(202, 207, 10, bad), car(203, 208, 5, 0, true)], daylight: bad, crowd: { near: bad, waiting: bad, crossing: bad }, intersection: { x: bad, z: 0 } }))
      tick(s, frame({ listener: { x: bad, y: 1, z: 0, yaw: 0, pitch: 0 } }))
      tick(s, frame({ cars: [car(Infinity, 0, 1)], interior: true }))
    }
  })
  // 240 Hz frames: the control pass runs on every ~4th.
  const l = ctxOf().listener as ParamListener
  const n0 = l.positionX.events.length
  for (let i = 0; i < 40; i++) tick(s, frame({ dt: 1 / 240, listener: { x: 200 + i, y: 1.7, z: 205, yaw: 0, pitch: 0 } }))
  const passes = l.positionX.events.length - n0
  assert.ok(passes >= 8 && passes <= 14, `${passes} control passes for 40 frames at 240 Hz`)
  s.dispose()
}))

test('dispose stops every source, closes the context and leaves an inert object', withFakes(() => {
  const s = new Soundscape()
  s.unlock()
  tick(s, frame({ walk: { ew: true, ns: false } }))
  const ctx = ctxOf()
  s.dispose()
  assert.equal(ctx.state, 'closed')
  for (const src of [...ctx.of(FakeOsc), ...ctx.of(FakeBufferSource)]) assert.ok(src.stopped >= 0, `${src.constructor.name} left running`)
  assert.equal(s.status().state, 'off')
  s.unlock()
  s.update(frame())
  s.setEnabled(true)
  s.setVolume(0.2)
  assert.equal(FakeContext.instances.length, 1, 'no context after dispose')
  s.dispose()
}))

test('a failing audio stack reports unsupported instead of throwing', withFakes(() => {
  const Broken = class { constructor() { throw new Error('NotAllowedError') } }
  g.AudioContext = Broken
  const s = new Soundscape()
  assert.doesNotThrow(() => s.unlock())
  assert.equal(s.status().state, 'unsupported')
  assert.doesNotThrow(() => s.update(frame()))
}))

test('recruitment cue: two soft notes, silent at both ends, bounded', () => {
  const n = cueLength(SYNTH_RATE)
  assert.ok(n > 0.4 * SYNTH_RATE && n < 0.7 * SYNTH_RATE, `${n} samples`)
  const out = new Float32Array(n).fill(9)
  renderCue(SYNTH_RATE, out)
  assert.ok(out.every((v) => Math.abs(v) <= CUE.amplitude + 1e-6))
  assert.ok(Math.abs(out[0]) < 1e-3 && Math.abs(out[n - 1]) < 1e-3, 'no click at either end')
  // Sound in each note, silence in the gap between them.
  const rms = (a: number, b: number) => Math.sqrt(out.slice(Math.round(a * SYNTH_RATE), Math.round(b * SYNTH_RATE)).reduce((t, v) => t + v * v, 0) / ((b - a) * SYNTH_RATE))
  assert.ok(rms(0.03, 0.13) > 0.1 && rms(0.25, 0.45) > 0.1)
  assert.ok(rms(0.165, 0.195) < 1e-3)
})

test('recruitment cue: sounds only while the soundscape runs, where the recruit stands, and is stopped with everything else', withFakes(() => {
  const s = new Soundscape()
  assert.equal(s.cue(200, 210), false, 'locked: no context before a gesture')
  assert.equal(FakeContext.instances.length, 0)
  s.unlock()
  const ctx = ctxOf()
  const cues = (graphOf(s) as unknown as { cues: { pan: { node: FakePanner }; source: FakeBufferSource | null }[] }).cues
  assert.equal(cues.length, CUE.slots)
  for (const bad of [NaN, Infinity, 1e39]) assert.equal(s.cue(bad, 0), false, String(bad))
  const before = ctx.of(FakeBufferSource).length
  assert.equal(s.cue(203, 208), true)
  const shot = ctx.of(FakeBufferSource).at(-1)!
  assert.equal(ctx.of(FakeBufferSource).length, before + 1)
  assert.ok(!shot.loop && shot.started >= 0 && shot.buffer!.length === cueLength(SYNTH_RATE))
  const p = cues.find((c) => c.source === shot)!.pan.node
  assert.deepEqual([p.positionX.target, p.positionY.target, p.positionZ.target], [203, CUE.height, 208])
  assert.equal(s.status().voices, 1)
  // More requests than voices: the one nearest its end is cut for the newest.
  assert.ok(s.cue(210, 210) && s.cue(220, 220))
  assert.ok(shot.stopped >= 0, 'the oldest shot was cut')
  assert.equal(s.status().voices, CUE.slots)
  // Over: no longer counted.
  ctx.currentTime += 1
  assert.equal(s.status().voices, 0)
  // Off: silent, and nothing new starts.
  s.setEnabled(false)
  assert.equal(s.cue(203, 208), false)
  s.setEnabled(true)
  assert.equal(s.cue(203, 208), true)
  const last = ctx.of(FakeBufferSource).at(-1)!
  s.dispose()
  assert.ok(last.stopped >= 0, 'dispose stops a cue that is still sounding')
  assert.equal(s.cue(203, 208), false)
}))

interface SpeechView { pan: { node: FakePanner }; gain: FakeGain; wall: FakeBiquad; source: FakeBufferSource | null; envelope: FakeGain | null }
const speechOf = (s: Soundscape) => (graphOf(s) as unknown as { speech: SpeechView }).speech

/** A WAV-sized buffer of `seconds` of 24 kHz 16-bit mono audio (the fake decoder only reads its length). */
const clipBytes = (seconds: number) => new ArrayBuffer(44 + Math.round(seconds * 24000) * 2)

test('speech: decoded only while the soundscape runs, from a copy of the bytes; anything else is refused in one sentence', withFakes(async () => {
  const s = new Soundscape()
  await assert.rejects(s.decodeSpeech(clipBytes(1)), { message: "the city's sound starts with the first click or key press on the page" })
  s.unlock()
  const ctx = ctxOf()
  const bytes = clipBytes(1.5)
  const buffer = await s.decodeSpeech(bytes)
  assert.equal(buffer.duration, 1.5)
  assert.equal(ctx.decoded.length, 1)
  assert.notEqual(ctx.decoded[0], bytes, 'a copy is decoded (the real call detaches what it is given)')
  assert.equal(ctx.decoded[0].byteLength, bytes.byteLength)
  await assert.rejects(s.decodeSpeech(new ArrayBuffer(8)), { message: "the speech server's audio could not be decoded" })
  s.setEnabled(false)
  await assert.rejects(s.decodeSpeech(bytes), { message: "the city's sound is off: type audio on" })
  s.setEnabled(true)
  ctx.state = 'suspended'
  await assert.rejects(s.decodeSpeech(bytes), { message: "the city's sound is paused while the page is hidden" })
}))

test('speech: said at the speaker\'s head through its own HRTF voice, followed as they walk, held when a reading is missing', withFakes(async () => {
  const s = new Soundscape()
  s.unlock()
  const ctx = ctxOf()
  const sp = speechOf(s)
  assert.equal(sp.gain.gain.value, SPEECH.level)
  assert.deepEqual([sp.pan.node.panningModel, sp.pan.node.refDistance, sp.pan.node.rolloffFactor], ['HRTF', SPEECH.refDistance, SPEECH.rolloff])
  const buffer = await s.decodeSpeech(clipBytes(2))
  assert.equal(s.speaking, false)
  const u = s.speak(buffer, 203, 208)
  const src = sp.source!
  assert.ok(src && src.buffer === (buffer as unknown as FakeBuffer) && src.started >= 0 && !src.loop)
  assert.deepEqual([sp.pan.node.positionX.target, sp.pan.node.positionY.target, sp.pan.node.positionZ.target], [203, SPEECH.height, 208])
  assert.ok(src.outputs[0] === sp.envelope && sp.envelope!.outputs[0] === sp.gain && sp.gain.outputs[0] === sp.wall && sp.wall.outputs[0] === sp.pan.node)
  assert.deepEqual([sp.wall.type, sp.wall.frequency.target, sp.gain.gain.target], ['lowpass', OCCLUSION.open, SPEECH.level], 'nothing in the way: unfiltered, full level')
  assert.equal(s.speaking, true)
  assert.equal(s.status().voices, 1)
  // The speaker walks: the voice glides after them each control pass.
  s.update(frame({ dt: 0.05, speaker: { x: 205, z: 211 } }))
  assert.deepEqual([sp.pan.node.positionX.target, sp.pan.node.positionZ.target], [205, 211])
  const glide = sp.pan.node.positionX.events.at(-1)!
  assert.deepEqual([glide.kind, glide.tau], ['target', SPEECH.follow])
  // No reading of them this frame: the voice stays where they were last heard.
  s.update(frame({ dt: 0.05, speaker: { x: NaN, z: NaN } }))
  s.update(frame({ dt: 0.05 }))
  assert.deepEqual([sp.pan.node.positionX.target, sp.pan.node.positionZ.target], [205, 211])
  // Played out: it ends on its own.
  let ended = false
  void u.ended.then(() => { ended = true })
  src.onended?.()
  await Promise.resolve()
  assert.ok(ended)
  assert.equal(s.speaking, false)
  assert.equal(s.status().voices, 0)
  // Nobody speaking: a speaker reading moves nothing.
  const events = sp.pan.node.positionX.events.length
  s.update(frame({ dt: 0.05, speaker: { x: 300, z: 300 } }))
  assert.equal(sp.pan.node.positionX.events.length, events)
  void ctx
}))

test('speech past buildings: the walls on the line from the head to the speaker, counted in the city\'s own boxes, and only those in the way', () => {
  const head = (x: number, z: number) => ({ x, y: 1.7, z })
  const mouth = (x: number, z: number) => ({ x, y: SPEECH.height, z })
  const wall = (x0: number, x1: number, y0 = 0, y1 = 10): Box => [x0, y0, -5, x1, y1, 5]
  assert.equal(wallsBetween([], head(0, 0), mouth(10, 0)), 0)
  assert.equal(wallsBetween([wall(4, 5)], head(0, 0), mouth(10, 0)), 1, 'a building between')
  assert.equal(wallsBetween([wall(4, 5), wall(6, 7)], head(0, 0), mouth(10, 0)), 2)
  assert.equal(wallsBetween([wall(4, 5), wall(6, 7), wall(8, 9)], head(0, 0), mouth(10, 0)), 2, 'counted to its limit')
  assert.equal(wallsBetween([wall(4, 5), wall(6, 7), wall(8, 9)], head(0, 0), mouth(10, 0), 5), 3)
  assert.equal(wallsBetween([wall(12, 13), wall(-3, -2)], head(0, 0), mouth(10, 0)), 0, 'past either end')
  assert.equal(wallsBetween([[4, 0, 6, 5, 10, 9]], head(0, 0), mouth(10, 0)), 0, 'beside the line: around a corner')
  assert.equal(wallsBetween([wall(4, 5, 0, LAKE.pier.deck), wall(6, 7, 0, 1.2)], head(0, 0), mouth(10, 0)), 0, 'a deck and a railing under head height')
  assert.equal(wallsBetween([wall(4, 5, 2.5, 6)], head(0, 0), mouth(10, 0)), 0, 'a canopy overhead')
  assert.equal(wallsBetween([wall(4, 5)], head(0, 0), mouth(0, 0)), 0, 'the same spot')
  assert.equal(wallsBetween([wall(-1, 1)], head(0, 0), mouth(0.5, 0)), 1, 'standing inside a box is behind it')
  assert.equal(wallsBetween([[-5, 0, 4, 5, 10, 5]], head(0, 0), mouth(0, 10)), 1, 'along z too')
  // The real city: across a lot, the buildings stand between; along a sidewalk, nothing does.
  const boxes = generateBuildings(1337).map((b) => b.box)
  const c = CITY.pitch * 8.5
  assert.ok(wallsBetween(boxes, head(c, CITY.pitch * 8 + CITY.lane), mouth(c, CITY.pitch * 9 - CITY.lane)) >= 1, 'through the lot between two streets')
  assert.equal(wallsBetween(boxes, head(c - 5, CITY.pitch * 8 + CITY.lane), mouth(c + 5, CITY.pitch * 8 + CITY.lane)), 0, 'along its sidewalk')
  // What the walls do to the voice.
  assert.deepEqual(muffle(0), { cutoff: OCCLUSION.open, gain: 1 })
  assert.deepEqual(muffle(1), { cutoff: OCCLUSION.one.cutoff, gain: OCCLUSION.one.gain })
  assert.deepEqual(muffle(2), { cutoff: OCCLUSION.more.cutoff, gain: OCCLUSION.more.gain })
  assert.deepEqual(muffle(7), muffle(2))
  assert.deepEqual(muffle(Number.NaN), muffle(0))
  assert.ok(OCCLUSION.more.cutoff < OCCLUSION.one.cutoff && OCCLUSION.one.cutoff < 4000 && OCCLUSION.more.gain < OCCLUSION.one.gain && OCCLUSION.one.gain < 1)
})

test('speech past buildings: the voice closes up as walls come between, and opens as the speaker steps clear', withFakes(async () => {
  const s = new Soundscape()
  s.unlock()
  const sp = speechOf(s)
  const buffer = await s.decodeSpeech(clipBytes(2))
  // Started behind a wall: muffled from the first sample.
  s.speak(buffer, 203, 208, 1)
  assert.deepEqual([sp.wall.frequency.target, sp.gain.gain.target], [OCCLUSION.one.cutoff, SPEECH.level * OCCLUSION.one.gain])
  assert.equal(sp.wall.frequency.events.at(-1)!.kind, 'set', 'jumped, not swept in from open')
  // They step clear: it opens, gliding.
  s.update(frame({ dt: 0.05, speaker: { x: 204, z: 208, walls: 0 } }))
  assert.deepEqual([sp.wall.frequency.target, sp.gain.gain.target], [OCCLUSION.open, SPEECH.level])
  const g = sp.wall.frequency.events.at(-1)!
  assert.deepEqual([g.kind, g.tau], ['target', OCCLUSION.glide])
  // Two buildings between: more muffled still. A reading that is missing changes nothing.
  s.update(frame({ dt: 0.05, speaker: { x: 230, z: 208, walls: 2 } }))
  assert.deepEqual([sp.wall.frequency.target, sp.gain.gain.target], [OCCLUSION.more.cutoff, SPEECH.level * OCCLUSION.more.gain])
  s.update(frame({ dt: 0.05, speaker: { x: NaN, z: NaN, walls: 0 } }))
  assert.deepEqual([sp.wall.frequency.target, sp.gain.gain.target], [OCCLUSION.more.cutoff, SPEECH.level * OCCLUSION.more.gain])
  // A new utterance in the open starts open.
  s.speak(buffer, 204, 208)
  assert.deepEqual([sp.wall.frequency.target, sp.gain.gain.target], [OCCLUSION.open, SPEECH.level])
}))

test('speech: a stop fades it out at once and ends it; a new utterance cuts the one playing; a stale stop cannot touch the new one', withFakes(async () => {
  const s = new Soundscape()
  s.unlock()
  const ctx = ctxOf()
  const sp = speechOf(s)
  const buffer = await s.decodeSpeech(clipBytes(3))
  ctx.currentTime = 10
  const first = s.speak(buffer, 200, 200)
  const firstSrc = sp.source!, firstEnv = sp.envelope!
  let firstEnded = false
  void first.ended.then(() => { firstEnded = true })
  ctx.currentTime = 11
  const second = s.speak(buffer, 201, 201)
  await Promise.resolve()
  assert.ok(firstEnded, 'the cut utterance ended')
  assert.deepEqual([firstEnv.gain.events.at(-1)?.v, firstEnv.gain.events.at(-1)?.tau], [0, SPEECH.fade], 'faded, not clicked off')
  assert.ok(Math.abs(firstSrc.stopped - (11 + SPEECH.fade * 6)) < 1e-9)
  assert.equal(s.status().voices, 1, 'one voice at a time')
  const secondSrc = sp.source!
  first.stop()
  assert.equal(secondSrc.stopped, -1, 'a stale stop leaves the new utterance alone')
  let secondEnded = false
  void second.ended.then(() => { secondEnded = true })
  ctx.currentTime = 12
  second.stop()
  second.stop()
  await Promise.resolve()
  assert.ok(secondEnded)
  assert.ok(Math.abs(secondSrc.stopped - (12 + SPEECH.fade * 6)) < 1e-9)
  assert.equal(s.speaking, false)
}))

test('speech: refused when it cannot sound or has nowhere to sound from; disposing ends what is playing', withFakes(async () => {
  const s = new Soundscape()
  s.unlock()
  const buffer = await s.decodeSpeech(clipBytes(1))
  for (const [x, z] of [[NaN, 0], [0, Infinity], [1e39, 0]]) assert.throws(() => s.speak(buffer, x, z), /no position to speak from/)
  s.setEnabled(false)
  assert.throws(() => s.speak(buffer, 1, 1), /the city's sound is off: type audio on/)
  s.setEnabled(true)
  const u = s.speak(buffer, 1, 1)
  const src = speechOf(s).source!
  let ended = false
  void u.ended.then(() => { ended = true })
  s.dispose()
  await Promise.resolve()
  assert.ok(ended, 'the context closed: the utterance ended with it')
  assert.ok(src.stopped >= 0)
  assert.throws(() => s.speak(buffer, 1, 1), /the city's sound is off/)
}))

// ------------------------------------------------------------------------------------ rooms, peers, captions

interface SendView { param: FakeParam }
interface ReverbView { convolver: FakeConvolver; key: string; pendingKey: string | null; beds: SendView; tones: SendView; cues: SendView }
interface PeerView { gain: FakeGain; wall: FakeBiquad; pan: { node: FakePanner }; live: boolean }
const reverbOf = (s: Soundscape) => (graphOf(s) as unknown as { reverb: ReverbView | null }).reverb
const peersOf = (s: Soundscape) => (graphOf(s) as unknown as { peers: Map<number, PeerView>; fading: PeerView[] })
const sendOf = (v: VoiceView) => (v as unknown as { send: SendView | null }).send
/** Whether `n` reaches the destination through `.outputs`. */
const reachesDestination = (ctx: FakeContext, n: FakeNode, seen = new Set<FakeNode>()): boolean =>
  n === ctx.destination || (!seen.has(n) && (seen.add(n), n.outputs.some((o) => reachesDestination(ctx, o, seen))))

const CITY_BOXES = generateBuildings(1337).map((b) => b.box)
/** A mid-block sidewalk of the city (a canyon), and the open ground. */
const CANYON = roomAt(CITY_BOXES, CITY.pitch * 8.5, CITY.pitch * 8 + CITY.lane)
const OPEN = roomAt([], 0, 0)

test('ping cue: two notes a fifth above the recruitment cue, silent at both ends, bounded', () => {
  const n = pingLength(SYNTH_RATE)
  assert.ok(n > 0.3 * SYNTH_RATE && n < 0.5 * SYNTH_RATE, `${n} samples`)
  const out = new Float32Array(n).fill(9)
  renderPing(SYNTH_RATE, out)
  assert.ok(out.every((v) => Math.abs(v) <= PING.amplitude + 1e-6))
  assert.ok(Math.abs(out[0]) < 1e-3 && Math.abs(out[n - 1]) < 1e-3, 'no click at either end')
  const first = [Math.round(0.01 * SYNTH_RATE), Math.round(0.09 * SYNTH_RATE)] as const
  assert.ok(power(out, SYNTH_RATE, PING.notes[0][2], ...first) > 20 * power(out, SYNTH_RATE, CUE.notes[0][2], ...first), 'the ping sits on its own note')
  const cue = new Float32Array(cueLength(SYNTH_RATE))
  renderCue(SYNTH_RATE, cue)
  const cueFirst = [Math.round(0.03 * SYNTH_RATE), Math.round(0.13 * SYNTH_RATE)] as const
  assert.ok(power(cue, SYNTH_RATE, CUE.notes[0][2], ...cueFirst) > 20 * power(cue, SYNTH_RATE, PING.notes[0][2], ...cueFirst), 'and the cue on its own')
  assert.ok(PING.notes[0][2] > CUE.notes[1][2], 'the ping starts above the cue\'s top note')
})

test('rooms: with a convolver the impulse is set once per room bucket, swapped behind silent sends, and every send starts from nothing', withFakes(() => {
  FakeContext.reverb = true
  const s = new Soundscape()
  s.unlock()
  const ctx = ctxOf()
  const rv = reverbOf(s)!
  assert.ok(rv, 'a reverb where the engine has a convolver')
  assert.equal(ctx.of(FakeConvolver).length, 1, 'one convolver per soundscape: the sends fan in')
  assert.equal(ctx.of(FakePanner).length, VOICE.count + MURMUR.sources + 1 + CUE.slots + 1, 'the reverb adds no panner')
  assert.equal(ctx.of(FakeBufferSource).length, VOICE.count, 'and no source')
  assert.equal(rv.convolver.normalize, false, 'the rendered impulse has unit energy: the sends alone set the wetness')
  assert.ok(reachesDestination(ctx, rv.convolver), 'the tail returns to the bus')
  const sends = ctx.of(FakeGain).filter((gn) => gn.outputs.includes(rv.convolver))
  assert.equal(sends.length, VOICE.count + 1 + 1 + 1 + 1, 'a send per car voice, one for the beds, the tones, the cues and the speech voice')
  for (const gn of sends) { assert.equal(gn.gain.value, 0, 'born silent'); assert.equal(gn.gain.automationRate, 'a-rate') }
  assert.equal(CANYON.kind, 'canyon')
  assert.equal(OPEN.kind, 'open')
  /** The impulse set now (read through a call, so an assertion on one reading narrows nothing for the next). */
  const bufferOf = (): FakeBuffer | null => rv.convolver.buffer
  // Dry until a room is known.
  tick(s, frame())
  assert.equal(bufferOf(), null)
  assert.equal(rv.key, '')
  // The first room: set at once (nothing is wet yet), the impulse exactly acoustics.ts's at the synthesis rate.
  tick(s, frame({ room: CANYON }))
  const first = bufferOf()!
  assert.ok(first)
  assert.equal(first.sampleRate, SYNTH_RATE)
  assert.equal(first.length, impulseLength(sabineRt60(CANYON), SYNTH_RATE))
  const expected = new Float32Array(first.length)
  renderImpulse(sabineRt60(CANYON), SYNTH_RATE, REVERB.seed, expected)
  assert.deepEqual(first.data, expected)
  assert.equal(rv.key, roomKey(CANYON))
  // The same bucket: nothing rendered, the same buffer.
  for (let i = 0; i < 5; i++) tick(s, frame({ room: CANYON }))
  assert.equal(bufferOf(), first)
  // Another bucket: the swap waits while the sends glide to nothing, then the open ground's shortest tail is set.
  tick(s, frame({ room: OPEN }))
  assert.equal(bufferOf(), first, 'not yet')
  assert.equal(rv.pendingKey, roomKey(OPEN))
  near(rv.beds.param.target, 0, 1e-12, 'the sends head for nothing before the swap')
  tick(s, frame({ room: OPEN }), REVERB.swap + 0.01)
  const open = bufferOf()!
  assert.ok(open !== first, 'swapped')
  assert.equal(open.length, impulseLength(sabineRt60(OPEN), SYNTH_RATE))
  assert.equal(rv.pendingKey, null)
  // Back in the canyon: the cached impulse, by identity.
  tick(s, frame({ room: CANYON }))
  tick(s, frame({ room: CANYON }), REVERB.swap + 0.01)
  assert.equal(bufferOf(), first)
  // Every send only ever glides, or jumps to nothing.
  for (const gn of sends) for (const e of gn.gain.events) assert.ok(e.kind === 'target' || (e.kind === 'set' && e.v === 0), `${e.kind} ${e.v}`)
  // The beds sit MURMUR.spread away; a far car is wetter than a near one, never beyond wetMax.
  near(rv.beds.param.target, eavesdrop(MURMUR.spread, 0).reverbSend, 1e-9)
  const cars = [car(205, 205, 10, Math.PI / 2), car(240, 205, 10, Math.PI / 2)]
  for (let i = 0; i < 30; i++) tick(s, frame({ cars, room: CANYON }))
  const gv = graphOf(s)
  const nearVoice = gv.voices.find((v) => v.car === 0)!, farVoice = gv.voices.find((v) => v.car === 1)!
  const nearSend = sendOf(nearVoice)!.param.target, farSend = sendOf(farVoice)!.param.target
  assert.ok(nearSend > 0 && farSend > nearSend && farSend <= ACOUSTICS.wetMax, `${nearSend} < ${farSend}`)
  near(farSend, eavesdrop(Math.hypot(240 + VOICE.nose - 200, 0), 0).reverbSend, 1e-6)
  // The walk tones: the intersection's distance.
  tick(s, frame({ cars, room: CANYON, intersection: { x: 240, z: 200 } }))
  near(rv.tones.param.target, eavesdrop(Math.hypot(40, 5), 0).reverbSend, 1e-9)
  // Inside the car the own engine stays dry; a released voice's send goes to nothing.
  const own = [car(200, 205.5, 9, 0, true), car(240, 205, 10, Math.PI / 2)]
  for (let i = 0; i < 30; i++) tick(s, frame({ cars: own, room: CANYON, interior: true }))
  near(sendOf(gv.voices.find((v) => v.car === 0)!)!.param.target, 0, 1e-12)
  for (let i = 0; i < 30; i++) tick(s, frame({ room: CANYON }))
  for (const v of gv.voices) near(sendOf(v)!.param.target, 0, 1e-12)
  s.dispose()
}))

test('rooms: speech from another room is coupled and reverberant; in the same room only the walls count; with no rooms it is exactly the wall table', withFakes(async () => {
  FakeContext.reverb = true
  const s = new Soundscape()
  s.unlock()
  const sp = speechOf(s)
  const send = (sp as unknown as { send: SendView }).send
  const buffer = await s.decodeSpeech(clipBytes(2))
  const here: Room = { x0: 190, z0: 190, x1: 210, z1: 220, height: 20, kind: 'canyon' }
  const there: Room = { x0: 230, z0: 190, x1: 250, z1: 220, height: 20, kind: 'canyon' }
  s.speak(buffer, 203, 208, 1)
  assert.deepEqual([sp.wall.frequency.target, sp.gain.gain.target], [OCCLUSION.one.cutoff, SPEECH.level * OCCLUSION.one.gain], 'started on the wall table alone')
  assert.deepEqual([send.param.target, send.param.events.at(-1)!.kind], [0, 'set'], 'dry at the start')
  // The speaker is in the next street: fainter still, wetter with distance.
  s.update(frame({ dt: 0.05, room: here, speaker: { x: 240, z: 208, walls: 1, room: there } }))
  const d = Math.hypot(240 - 200, 208 - 205)
  assert.deepEqual([sp.wall.frequency.target, sp.gain.gain.target], [OCCLUSION.one.cutoff, SPEECH.level * OCCLUSION.one.gain * ACOUSTICS.coupling])
  near(send.param.target, eavesdrop(d, 1, here, there).reverbSend, 1e-9)
  assert.ok(send.param.target > 0.2 && send.param.target <= ACOUSTICS.wetMax)
  assert.deepEqual([send.param.events.at(-1)!.kind, send.param.events.at(-1)!.tau], ['target', REVERB.glide])
  // The same room: the wall alone; nearer: drier.
  s.update(frame({ dt: 0.05, room: here, speaker: { x: 204, z: 208, walls: 1, room: here } }))
  assert.deepEqual([sp.wall.frequency.target, sp.gain.gain.target], [OCCLUSION.one.cutoff, SPEECH.level * OCCLUSION.one.gain])
  near(send.param.target, eavesdrop(5, 1).reverbSend, 1e-9)
  // No rooms given: muffle(), exactly as before rooms existed.
  s.update(frame({ dt: 0.05, speaker: { x: 204, z: 208, walls: 2 } }))
  assert.deepEqual([sp.wall.frequency.target, sp.gain.gain.target], [OCCLUSION.more.cutoff, SPEECH.level * OCCLUSION.more.gain])
  assert.deepEqual(muffle(1), { cutoff: eavesdrop(0, 1).cutoff, gain: eavesdrop(0, 1).gain })
  s.dispose()
}))

test('peers: a voice is placed at its player, muffled by the walls between, follows the frame, and detaches with a fade', withFakes(() => {
  FakeContext.streams = true
  const stream = { id: 'remote' } as unknown as MediaStream
  const s = new Soundscape()
  assert.equal(s.attachPeer(stream, 1), null, 'locked: nothing to attach to')
  s.unlock()
  const ctx = ctxOf()
  const panners = ctx.of(FakePanner).length
  const p = s.attachPeer(stream, 1, 'Mara')
  assert.ok(p, 'attached')
  assert.equal(ctx.of(FakePanner).length, panners + 1, 'its own HRTF panner, made on attach')
  assert.equal(ctx.of(FakeStreamSource).length, 1)
  const src = ctx.of(FakeStreamSource)[0]
  assert.equal(src.stream, stream, 'the host\'s stream, as given')
  const peers = peersOf(s)
  const pv = peers.peers.get(1)!
  assert.ok(src.outputs[0] === pv.gain && pv.gain.outputs[0] === pv.wall && pv.wall.outputs[0] === pv.pan.node, 'stream → level → wall → panner')
  assert.ok(reachesDestination(ctx, pv.pan.node))
  assert.deepEqual([pv.pan.node.panningModel, pv.pan.node.refDistance, pv.pan.node.rolloffFactor], ['HRTF', SPEECH.refDistance, SPEECH.rolloff])
  assert.equal(pv.wall.frequency.automationRate, 'k-rate')
  assert.equal(pv.gain.gain.value, 0, 'silent until placed')
  assert.equal(pv.live, false)
  assert.equal(s.status().voices, 0)
  tick(s, frame())
  p!.place(210, 205, 1)
  assert.deepEqual([pv.pan.node.positionX.target, pv.pan.node.positionY.target, pv.pan.node.positionZ.target], [210, SPEECH.height, 205])
  assert.equal(pv.pan.node.positionX.events.at(-1)!.kind, 'set', 'the first placement jumps')
  const up = pv.gain.gain.events.at(-1)!
  assert.deepEqual([up.kind, up.v], ['target', SPEECH.level * OCCLUSION.one.gain], 'swells in to the level the wall allows')
  assert.deepEqual([pv.wall.frequency.target, pv.wall.frequency.events.at(-1)!.kind], [OCCLUSION.one.cutoff, 'set'])
  assert.equal(s.status().voices, 1, 'counted while it sounds')
  // The frame moves them, with the speech follow; the wall opens with the occlusion glide; unknown ids are ignored.
  tick(s, frame({ peers: [{ id: 1, x: 212, z: 206, walls: 0 }, { id: 9, x: 0, z: 0 }] }))
  assert.deepEqual([pv.pan.node.positionX.target, pv.pan.node.positionZ.target], [212, 206])
  const glide = pv.pan.node.positionX.events.at(-1)!
  assert.deepEqual([glide.kind, glide.tau], ['target', SPEECH.follow])
  assert.deepEqual([pv.gain.gain.target, pv.wall.frequency.target], [SPEECH.level, OCCLUSION.open])
  assert.equal(pv.wall.frequency.events.at(-1)!.tau, OCCLUSION.glide)
  assert.equal(ctx.of(FakePanner).length, panners + 1, 'no panner per frame')
  // Detach: a fade, then the nodes are let go once it is inaudible.
  p!.detach()
  const down = pv.gain.gain.events.at(-1)!
  assert.deepEqual([down.kind, down.v, down.tau], ['target', 0, SPEECH.fade])
  assert.equal(s.status().voices, 0)
  assert.equal(peers.peers.has(1), false)
  assert.equal(peers.fading.length, 1)
  tick(s, frame({ peers: [{ id: 1, x: 300, z: 300 }] }), SPEECH.fade * 6 + 0.01)
  assert.equal(src.outputs.length, 0, 'released once silent')
  assert.equal(peers.fading.length, 0)
  assert.doesNotThrow(() => { p!.detach(); p!.place(1, 1) })
  // A second attach of the same id lets the first go; a source that cannot be made is a null, not a throw.
  const q = s.attachPeer(stream, 2), r = s.attachPeer(stream, 2)
  assert.ok(q && r && q !== r)
  assert.equal(peers.peers.size, 1)
  ctx.createMediaStreamSource = () => { throw new Error('NotSupportedError') }
  assert.equal(s.attachPeer(stream, 3), null)
  assert.equal(s.status().state, 'running')
  assert.equal(s.attachPeer(stream, Number.NaN), null)
  s.setEnabled(false)
  assert.equal(s.attachPeer(stream, 4), null, 'off: refused like speech')
  s.setEnabled(true)
  s.dispose()
  assert.equal(peers.peers.size, 0, 'dispose lets every peer go')
}))

test('peers: without a MediaStream source in the browser attachPeer is null and nothing else changes', withFakes(() => {
  const s = new Soundscape()
  s.unlock()
  const ctx = ctxOf()
  const n = ctx.nodes.length
  assert.equal(s.attachPeer({} as unknown as MediaStream, 1), null)
  assert.equal(ctx.nodes.length, n)
  assert.equal(s.status().state, 'running')
  s.dispose()
}))

test('every sound start, change and stop is reported once with its position; a listener that throws cannot take the sound down', withFakes(async () => {
  const s = new Soundscape()
  const events: CaptionEvent[] = []
  s.onSound = (e) => events.push(e)
  const quiet = { near: 0, waiting: 0, crossing: 0 }
  const of = (kind: CaptionEvent['kind'], phase?: CaptionEvent['phase']) => events.filter((e) => e.kind === kind && (phase === undefined || e.phase === phase))
  s.update(frame({ cars: [car(210, 205, 11)] }))
  s.cue(1, 1)
  assert.equal(events.length, 0, 'no event before unlock')
  s.unlock()
  const ctx = ctxOf()
  while (graphOf(s).babbleJob) tick(s, frame({ crowd: quiet }))
  assert.equal(events.length, 0, 'nothing sounds in an empty street')
  // A car driving at the listener: its voice starts at its nose, approaching.
  const cars = [car(210, 205, 5, -Math.PI / 2)]
  tick(s, frame({ cars, crowd: quiet }))
  assert.equal(of('engine').length, 1)
  const start = of('engine')[0]
  assert.deepEqual([start.phase, start.source, start.detail, start.t], ['start', 0, 'approaching', ctx.currentTime])
  near(start.x, 210 - VOICE.nose, 1e-6); near(start.z, 205, 1e-6)
  assert.equal(of('tyres').length, 0, 'the engine is louder than the tyres at 18 km/h')
  // Held at that speed, the line is only refreshed (a repeated start), not retexted.
  events.length = 0
  for (let i = 0; i < 300; i++) tick(s, frame({ cars, crowd: quiet }))
  assert.ok(of('engine', 'start').length >= 1 && of('engine', 'start').length <= 5 / CAPTION_REFRESH + 1, `${of('engine', 'start').length} refreshes in 5 s`)
  assert.equal(of('engine', 'change').length, 0)
  // Speeding up: a gear shift, then the tyres take over.
  events.length = 0
  for (let v = 5; v <= 24; v += 1) { cars[0] = car(210, 205, v, -Math.PI / 2); tick(s, frame({ cars, crowd: quiet })) }
  assert.ok(of('engine', 'change').some((e) => e.detail === 'up'), 'shifted up')
  assert.deepEqual(of('tyres').map((e) => [e.phase, e.source]), [['start', 0]])
  // Gone out of range: the engine and the tyres stop, once.
  events.length = 0
  cars[0] = car(600, 600, 24, 0)
  for (let i = 0; i < 10; i++) tick(s, frame({ cars, crowd: quiet }))
  assert.deepEqual(of('engine').map((e) => [e.phase, e.source]), [['stop', 0]])
  assert.deepEqual(of('tyres').map((e) => [e.phase, e.source]), [['stop', 0]])
  // The walk signal at the intersection, per axis.
  events.length = 0
  const at = { x: 240, z: 200 }
  tick(s, frame({ walk: { ew: false, ns: true }, intersection: at, crowd: quiet }))
  assert.deepEqual(of('walk-signal').map((e) => [e.phase, e.source, e.x, e.z, e.detail]), [['start', 0, 240, 200, 'ns']])
  for (let i = 0; i < 10; i++) tick(s, frame({ walk: { ew: false, ns: true }, intersection: at, crowd: quiet }))
  assert.equal(of('walk-signal', 'stop').length, 0)
  tick(s, frame({ walk: { ew: true, ns: false }, intersection: at, crowd: quiet }))
  assert.deepEqual(of('walk-signal').slice(-2).map((e) => [e.phase, e.source, e.detail]), [['start', 1, 'ew'], ['stop', 0, 'ns']])
  tick(s, frame({ intersection: at, crowd: quiet }))
  // The recruitment cue and the ping, where they sound.
  events.length = 0
  assert.ok(s.cue(203, 208))
  assert.deepEqual(of('cue').map((e) => [e.phase, e.x, e.z]), [['start', 203, 208]])
  assert.ok(s.cuePing(220, 230))
  assert.deepEqual(of('ping').map((e) => [e.phase, e.x, e.z]), [['start', 220, 230]])
  const shots = ctx.of(FakeBufferSource).slice(-2)
  assert.notEqual(shots[0].buffer, shots[1].buffer, 'the ping has its own buffer')
  assert.equal(shots[1].buffer!.length, pingLength(SYNTH_RATE))
  shots[0].onended?.()
  assert.deepEqual(of('cue', 'stop').length, 1, 'a shot that played out stops its caption')
  // Speech carries the words and the speaker; it follows them and says when a wall comes between; a stop ends it.
  const buffer = await s.decodeSpeech(clipBytes(2))
  events.length = 0
  const u = s.speak(buffer, 203, 208, 0, 'over here', { agent: 12, label: 'Pedestrian 12 (Rust)' })
  assert.deepEqual(of('speech'), [{ kind: 'speech', phase: 'start', source: 12, x: 203, z: 208, t: ctx.currentTime, text: 'over here', label: 'Pedestrian 12 (Rust)', agent: 12, detail: 'clear' }])
  s.update(frame({ dt: 0.05, speaker: { x: 206, z: 210, walls: 1 }, crowd: quiet }))
  const change = of('speech', 'change')
  assert.equal(change.length, 1)
  assert.deepEqual([change[0].source, change[0].x, change[0].z, change[0].text, change[0].detail], [12, 206, 210, 'over here', 'muffled'])
  u.stop()
  assert.deepEqual(of('speech', 'stop').map((e) => [e.source, e.agent]), [[12, 12]])
  events.length = 0
  s.speak(buffer, 203, 208)
  const src = speechOf(s).source!
  src.onended?.()
  assert.deepEqual(of('speech').map((e) => [e.phase, e.source]), [['start', 0], ['stop', 0]], 'played out: ended on its own')
  // The cabin, with no place of its own.
  events.length = 0
  const driven = [car(200, 205, 5, 0, true)]
  tick(s, frame({ cars: driven, interior: true, crowd: quiet }))
  tick(s, frame({ cars: driven, interior: false, crowd: quiet }))
  assert.deepEqual(of('cabin').map((e) => [e.phase, Number.isNaN(e.x), Number.isNaN(e.z)]), [['start', true, true], ['stop', true, true]])
  assert.equal(of('engine', 'start').length, 1, 'the driven car is not captioned; it is once it is driven no more')
  // The murmur: a busy daytime crowd starts it at a bed; an empty street ends it.
  events.length = 0
  tick(s, frame())
  const murmur = of('murmur')
  assert.equal(murmur.length, 1)
  assert.deepEqual([murmur[0].phase, murmur[0].detail, Number.isFinite(murmur[0].x + murmur[0].z)], ['start', 'busy', true])
  tick(s, frame({ crowd: { near: 10, waiting: 10, crossing: 0 } }))
  assert.deepEqual(of('murmur').at(-1)!.detail, 'quiet', 'retexted as the crowd thins')
  tick(s, frame({ crowd: quiet }))
  assert.equal(of('murmur').at(-1)!.phase, 'stop')
  // Every event is a fresh object with a finite time on the audio clock.
  for (const e of events) assert.ok(Number.isFinite(e.t) && e.t <= ctx.currentTime)
  assert.equal(new Set(events).size, events.length)
  assert.equal(s.clock, ctx.currentTime)
  // A listener that throws: the pass finishes, the stack keeps running.
  s.onSound = () => { throw new Error('caption fault') }
  assert.doesNotThrow(() => { for (let i = 0; i < 5; i++) tick(s, frame({ cars: [car(205, 205, 10)] })) })
  assert.equal(s.status().state, 'running')
  assert.ok(graphOf(s).voices.some((v) => v.car === 0), 'the car is voiced all the same')
  s.onSound = null
  const t = s.clock
  s.dispose()
  assert.equal(s.clock, t, 'the clock holds where it stopped')
}))

// Local split screen (Design B): several soundscapes over one shared context, each in head space

/** The number of panners one soundscape builds: car voices, murmur beds, the walk tones, the cues, speech. */
const pannersOf = (voices: number, beds: number) => voices + beds + 1 + CUE.slots + 1

test('toHeadSpace: a rigid move into the head frame, the inverse of listenerBasis, right of the head to +x and ahead to −z', () => {
  const rng = createRng(0x5ea7)
  const b = new Float32Array(6)
  const out = { x: 0, y: 0, z: 0 }
  for (let i = 0; i < 100; i++) {
    const yaw = (rng() - 0.5) * 4 * Math.PI, pitch = (rng() - 0.5) * 2.9
    const L = { x: rng() * 400, y: 1.7, z: rng() * 400 }
    const P = { x: rng() * 400, y: rng() * 3, z: rng() * 400 }
    listenerBasis(yaw, pitch, b)
    toHeadSpace(b, L.x, L.y, L.z, P.x, P.y, P.z, out)
    const d = Math.hypot(P.x - L.x, P.y - L.y, P.z - L.z)
    near(Math.hypot(out.x, out.y, out.z), d, 1e-6 * d, 'the distance is unchanged (the basis is single precision)')
    // Back to the world through the camera's own rotation (YXZ, as listenerBasis): the inverse holds.
    const back = new Vector3(out.x, out.y, out.z).applyEuler(new Euler(pitch, yaw, 0, 'YXZ'))
    near(back.x, P.x - L.x, 1e-3); near(back.y, P.y - L.y, 1e-3); near(back.z, P.z - L.z, 1e-3)
  }
  listenerBasis(0, 0, b)
  toHeadSpace(b, 200, 1.7, 205, 210, 1.7, 205, out)
  assert.deepEqual([out.x, out.y, out.z].map((v) => Math.round(v * 1e6) / 1e6 + 0), [10, 0, 0], 'yaw 0: +x is to the right')
  toHeadSpace(b, 200, 1.7, 205, 200, 1.7, 195, out)
  assert.deepEqual([out.x, out.y, out.z].map((v) => Math.round(v * 1e6) / 1e6 + 0), [0, 0, -10], 'yaw 0: −z is ahead')
  listenerBasis(-Math.PI / 2, 0, b)
  toHeadSpace(b, 200, 1.7, 205, 210, 1.7, 205, out)
  assert.deepEqual([out.x, out.y, out.z].map((v) => Math.round(v * 1e6) / 1e6 + 0), [0, 0, -10], 'turned to +x: the same point is ahead')
})

test('two soundscapes on one page own separate contexts and listeners; disposing one closes only its context', withFakes(() => {
  const a = new Soundscape(), b = new Soundscape()
  a.unlock()
  b.unlock()
  assert.equal(FakeContext.instances.length, 2)
  const [ca, cb] = FakeContext.instances
  tick(a, frame({ listener: { x: 10, y: 1.7, z: 20, yaw: 0, pitch: 0 } }))
  ctxOf().currentTime += 1 / 60
  b.update(frame({ listener: { x: 10, y: 1.7, z: 20, yaw: Math.PI, pitch: 0 } }))
  near((ca.listener as ParamListener).forwardZ.target, -1, 1e-6, 'A looks down −z')
  near((cb.listener as ParamListener).forwardZ.target, 1, 1e-6, 'B looks down +z')
  assert.equal(ca.of(FakePanner).length, pannersOf(VOICE.count, MURMUR.sources))
  assert.equal(cb.of(FakePanner).length, pannersOf(VOICE.count, MURMUR.sources))
  a.dispose()
  assert.equal(ca.state, 'closed')
  assert.equal(cb.state, 'running', 'B plays on')
  assert.equal(b.status().state, 'running')
  b.dispose()
  assert.equal(cb.state, 'closed')
}))

test('a shared context in head space: one context, the listener left at the identity, every source placed relative to its head', withFakes(() => {
  const share = sharedAudioContext()
  const p1 = new Soundscape({ context: share, space: 'head' })
  const p2 = new Soundscape({ context: share, space: 'head' })
  p1.unlock()
  p2.unlock()
  assert.equal(FakeContext.instances.length, 1, 'one context for both')
  const ctx = ctxOf()
  const l = ctx.listener as ParamListener
  const params = [l.positionX, l.positionY, l.positionZ, l.forwardX, l.forwardY, l.forwardZ, l.upX, l.upY, l.upZ]
  while (graphOf(p1).babbleJob) { tick(p1, frame()); p2.update(frame()) }
  const identity = [0, 0, 0, 0, 0, -1, 0, 1, 0]
  params.forEach((p, i) => near(p.target, identity[i], 1e-9, `listener param ${i} at the identity`))
  const events = params.map((p) => p.events.length)
  // The car sits 10 m to the right of player 1 (yaw 0) and straight ahead of player 2 (turned to +x), nose on +x.
  const cars = [car(210, 205, 0, Math.PI / 2)]
  const f1 = frame({ cars, listener: { x: 200, y: 1.7, z: 205, yaw: 0, pitch: 0 } })
  const f2 = frame({ cars, listener: { x: 200, y: 1.7, z: 205, yaw: -Math.PI / 2, pitch: 0 } })
  for (let i = 0; i < 30; i++) { tick(p1, f1); p2.update(f2) }
  params.forEach((p, i) => assert.equal(p.events.length, events[i], 'the listener is never moved again'))
  const v1 = graphOf(p1).voices.find((v) => v.car === 0)!
  const v2 = graphOf(p2).voices.find((v) => v.car === 0)!
  near(v1.pan.node.positionX.target, 10 + VOICE.nose, 0.02, 'to the right of player 1')
  near(v1.pan.node.positionY.target, VOICE.height - 1.7, 1e-6)
  near(v1.pan.node.positionZ.target, 0, 0.02)
  near(v2.pan.node.positionX.target, 0, 0.02)
  near(v2.pan.node.positionZ.target, -(10 + VOICE.nose), 0.02, 'ahead of player 2')
  const d = Math.hypot(10 + VOICE.nose, VOICE.height - 1.7)
  near(Math.hypot(v1.pan.node.positionX.target, v1.pan.node.positionY.target, v1.pan.node.positionZ.target), d, 1e-3, 'the distance is the world distance')
  near(Math.hypot(v2.pan.node.positionX.target, v2.pan.node.positionY.target, v2.pan.node.positionZ.target), d, 1e-3)
  // The Doppler reads the world, not the head: both players hear the same pitch from the same still car.
  near(v1.freq.param.target, v2.freq.param.target, 1e-9)
  // The beds sit on the sidewalks in the world (murmurLayout) and in the head frame here: the same distances.
  const layout = new Float32Array(8)
  murmurLayout(200, 205, layout)
  const bed = graphOf(p1).beds[0].pan.node
  near(Math.hypot(bed.positionX.target, bed.positionY.target, bed.positionZ.target), Math.hypot(layout[0] - 200, MURMUR.height - 1.7, layout[1] - 205), 1e-3)
  // The world-space default is untouched: a third soundscape of its own moves its listener as before.
  const alone = new Soundscape()
  alone.unlock()
  const own = ctxOf()
  assert.notEqual(own, ctx)
  tick(alone, frame({ listener: { x: 10, y: 1.7, z: 20, yaw: 0, pitch: 0 } }))
  near((own.listener as ParamListener).positionX.target, 10, 1e-9)
  alone.dispose()
  p1.dispose()
  assert.equal(ctx.state, 'running', 'the context lives on for player 2')
  assert.equal(p2.status().state, 'running')
  p2.dispose()
  assert.equal(ctx.state, 'closed', 'the last player out closes it')
  assert.equal(FakeContext.instances.length, 2)
}))

test('four players: panners = 4 × (voices + beds + 1 + CUE.slots + 1) with the per-player pools; each reports its own voices', withFakes(() => {
  const share = sharedAudioContext()
  const players = [0, 1, 2, 3].map(() => new Soundscape({ context: share, space: 'head', voices: 3, beds: 2 }))
  for (const p of players) p.unlock()
  assert.equal(FakeContext.instances.length, 1)
  const ctx = ctxOf()
  assert.equal(ctx.of(FakePanner).length, 4 * pannersOf(3, 2))
  assert.equal(ctx.of(FakeCompressor).length, 4, 'a limiter each, into the one destination')
  for (const c of ctx.of(FakeCompressor)) assert.ok(c.outputs.includes(ctx.destination))
  for (const p of players) while (graphOf(p).babbleJob) tick(p, frame({ crowd: { near: 0, waiting: 0, crossing: 0 } }))
  const cars = [car(210, 205, 8, Math.PI / 2), car(200, 215, 8), car(190, 205, 8, -Math.PI / 2), car(200, 195, 8, Math.PI), car(220, 205, 8, Math.PI / 2)]
  const quiet = { near: 0, waiting: 0, crossing: 0 }
  const far = { x: 900, y: 1.7, z: 900, yaw: 0, pitch: 0 }
  for (let i = 0; i < 30; i++) {
    tick(players[0], frame({ cars, crowd: quiet }))
    players[1].update(frame({ cars, crowd: quiet, listener: far }))
    players[2].update(frame({ cars, crowd: { near: 80, waiting: 40, crossing: 20 } }))
    players[3].update(frame({ cars: [], crowd: quiet, walk: { ew: true, ns: true } }))
  }
  assert.equal(players[0].status().voices, 3, 'three of five cars, the pool is three')
  assert.equal(players[1].status().voices, 0, 'nothing within range of player 2')
  assert.equal(players[2].status().voices, 3 + 2, 'cars and the two beds')
  assert.equal(players[3].status().voices, 2, 'the two walk tones')
  for (const p of players) p.dispose()
  assert.equal(ctx.state, 'closed')
}))

test('head-space cut: a turn of 90° or more jumps every placed source instead of gliding it round the head', withFakes(() => {
  const share = sharedAudioContext()
  const s = new Soundscape({ context: share, space: 'head' })
  s.unlock()
  const cars = [car(210, 205, 8, Math.PI / 2)]
  const lastKind = (p: FakeParam) => p.events[p.events.length - 1].kind
  tick(s, frame({ cars, listener: { x: 200, y: 1.7, z: 205, yaw: 0, pitch: 0 } }))
  const v = graphOf(s).voices.find((x) => x.car === 0)!
  assert.equal(lastKind(v.pan.node.positionX), 'set', 'the first placement jumps')
  tick(s, frame({ cars, listener: { x: 200.5, y: 1.7, z: 205, yaw: 0.05, pitch: 0 } }))
  assert.equal(lastKind(v.pan.node.positionX), 'target', 'ordinary motion glides')
  tick(s, frame({ cars, listener: { x: 200.5, y: 1.7, z: 205, yaw: 0.05 + Math.PI * 0.97, pitch: 0 } }))
  for (const p of [v.pan.node.positionX, v.pan.node.positionZ]) assert.equal(lastKind(p), 'set', 'the car is on the other side now')
  for (const b of graphOf(s).beds) assert.equal(lastKind(b.pan.node.positionX), 'set', 'the beds too')
  assert.ok(v.pan.node.positionX.value < 0, 'and to the left after the turn')
  tick(s, frame({ cars, listener: { x: 200.5, y: 1.7, z: 205, yaw: 0.1 + Math.PI * 0.97, pitch: 0 } }))
  assert.equal(lastKind(v.pan.node.positionX), 'target', 'and glides again afterwards')
  s.dispose()
}))

test('a shared context survives a soundscape that fails or is left locked; pool options are clamped', withFakes(() => {
  const share = sharedAudioContext()
  const a = new Soundscape({ context: share, space: 'head', voices: 0, beds: 99 })
  const b = new Soundscape({ context: share, space: 'head', voices: Number.NaN, beds: 2.7 })
  const locked = new Soundscape({ context: share, space: 'head' })
  a.unlock()
  b.unlock()
  const ctx = ctxOf()
  assert.equal(graphOf(a).voices.length, 1, 'at least one voice')
  assert.equal(graphOf(a).beds.length, MURMUR.sources, 'no more beds than the layout has')
  assert.equal(graphOf(b).voices.length, VOICE.count, 'NaN is the default')
  assert.equal(graphOf(b).beds.length, 2, 'rounded down')
  // A broken frame takes one soundscape down (unsupported from then on) and leaves the context to the other.
  tick(a, frame({ listener: { x: 1e39, y: 1.7, z: 205, yaw: 0, pitch: 0 }, cars: [car(1e39, 205, 8)] }))
  assert.ok(a.status().state === 'running' || a.status().state === 'unsupported')
  a.dispose()
  assert.equal(ctx.state, 'running')
  assert.equal(b.status().state, 'running')
  locked.dispose()
  assert.equal(ctx.state, 'running', 'a soundscape that never unlocked held nothing')
  b.dispose()
  assert.equal(ctx.state, 'closed')
  assert.equal(FakeContext.instances.length, 1)
}))
