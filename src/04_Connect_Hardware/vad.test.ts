// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the voice activity detector (vad.ts): a quiet room is never speech,
 * a harmonic voice-like signal over the room is speech after the onset and stays through a short pause, broadband
 * hiss at the same level is not, a shout that never ends becomes the room only slowly, the page speaking raises the
 * bar, Sloane's own line in syllables (pauses, a late start, reverberation) never cuts itself while a visitor talking
 * over it does, odd input (NaN, blocks of any size) never throws, the FFT is an FFT, and the worklet module the page builds
 * from the class is valid JavaScript that registers a processor and detects speech in a stub AudioWorklet scope.
 * What breaks if it is removed? A tuning change could make the pill read "Hearing you" to a fan, or never, or let
 * Sloane cut her own lines, with nothing to say so; or the serialised worklet could stop parsing after a build change.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VAD, VAD_PROCESSOR, VadCore, vadFrame, vadWorkletSource } from './vad.ts'

const SR = 48_000

/** A deterministic noise source (xorshift), in −1..1. */
function noise(seed = 1): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return (s / 0xffffffff) * 2 - 1
  }
}

/** `seconds` of a quiet room: white noise at `level` RMS. */
function room(seconds: number, level = 0.003, seed = 7): Float32Array {
  const n = Math.round(seconds * SR), out = new Float32Array(n), r = noise(seed)
  // Uniform noise has RMS 1/√3: scale to the level asked.
  const k = level * Math.sqrt(3)
  for (let i = 0; i < n; i++) out[i] = r() * k
  return out
}

/** `seconds` of a voice-like signal: a 140 Hz fundamental with eight harmonics, a little vibrato, at `level` RMS, over the room. */
function voice(seconds: number, level = 0.08, seed = 11): Float32Array {
  const n = Math.round(seconds * SR), out = room(seconds, 0.003, seed)
  const f0 = 140
  let sum = 0
  const raw = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const f = f0 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * t))
    let v = 0
    for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f * h * t + h) / h
    raw[i] = v
    sum += v * v
  }
  const k = level / Math.sqrt(sum / n)
  for (let i = 0; i < n; i++) out[i] += raw[i] * k
  return out
}

/** Hiss: white noise at a voice's level. */
const hiss = (seconds: number, level = 0.08): Float32Array => room(seconds, level, 23)

/** A steady hum: white noise through a one-pole low-pass (few zero crossings, so it votes voiced), at `level` RMS. */
function hum(seconds: number, level: number, seed = 31): Float32Array {
  const n = Math.round(seconds * SR), out = new Float32Array(n), r = noise(seed)
  let y = 0, sum = 0
  for (let i = 0; i < n; i++) { y = 0.97 * y + 0.03 * r(); out[i] = y; sum += y * y }
  const k = level / Math.sqrt(sum / n)
  for (let i = 0; i < n; i++) out[i] *= k
  return out
}

/** `x` with a voice's onset: rising `db` decibels over its first `ms` milliseconds, exponentially. */
function onset(x: Float32Array, ms: number, db = 30): Float32Array {
  const out = Float32Array.from(x), n = Math.min(out.length, Math.round((ms / 1000) * SR))
  for (let i = 0; i < n; i++) out[i] *= 10 ** ((db * (i / n - 1)) / 20)
  return out
}

/** Speech-shaped: `sentences` of 6 to 14 syllables (140 to 300 ms each, a sin² envelope down to a trough of 0.1, each
 *  syllable's loudness spread by `sigmaDb` decibels), `pause` seconds of the room between sentences, a voice (`f0`, eight
 *  harmonics) at `peak` RMS on a syllable's crest, through a room's reverberation (`rt60` seconds), over the room;
 *  `louder` scales the last sentence (her voice rising at the end of a line). */
function syllables(seed: number, o: { peak: number; sentences: number; pause: number; sigmaDb?: number; louder?: number; f0?: number; rt60?: number }): Float32Array {
  const r = noise(seed + 1000), env: number[] = [], ms = (s: number): number => Math.round(s * 1000)
  const gauss = (): number => Math.sqrt(-2 * Math.log(Math.max(1e-9, (r() + 1) / 2))) * Math.cos(Math.PI * (r() + 1))
  for (let s = 0; s < o.sentences; s++) {
    const count = 6 + Math.floor(((r() + 1) / 2) * 9), gain = s === o.sentences - 1 ? o.louder ?? 1 : 1
    for (let k = 0; k < count; k++) {
      const d = ms(0.14 + ((r() + 1) / 2) * 0.16), g = gain * 10 ** ((gauss() * (o.sigmaDb ?? 3)) / 20)
      for (let i = 0; i < d; i++) env.push(g * (0.1 + 0.9 * Math.sin((Math.PI * i) / d) ** 2))
    }
    if (s < o.sentences - 1) for (let i = 0; i < ms(o.pause); i++) env.push(0)
  }
  // A millisecond envelope; the reverberation adds a decaying tail of its energy.
  const a = Math.exp(-6.9 / ((o.rt60 ?? 0.3) * 1000))
  let tail = 0
  const shaped = env.map((e) => { tail = tail * a + e * e * (1 - a); return Math.sqrt(e * e + 0.3 * tail) })
  const per = SR / 1000, n = shaped.length * per, out = room(n / SR, 0.003, seed), raw = new Float32Array(n), f0 = o.f0 ?? 140
  let sum = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR, f = f0 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * t))
    let v = 0
    for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f * h * t + h) / h
    raw[i] = v
    sum += v * v
  }
  const k = o.peak / Math.sqrt(sum / n)
  for (let i = 0; i < n; i++) out[i] += raw[i] * k * shaped[Math.floor(i / per)]
  return out
}

/** A click (a key, a pad's button, a tap on the desk): `ms` of noise decaying from `peak`. */
function click(peak: number, ms = 8, seed = 3): Float32Array {
  const n = Math.round((ms / 1000) * SR), r = noise(seed), out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = r() * peak * Math.exp((-4 * i) / n)
  return out
}

/** `b` heard over `a` from sample `at` on. */
function over(a: Float32Array, b: Float32Array, at: number): Float32Array {
  const out = new Float32Array(Math.max(a.length, at + b.length))
  out.set(a)
  for (let i = 0; i < b.length; i++) out[at + i] += b[i]
  return out
}

/** Two signals heard at once (sample by sample; the shorter one ends early). */
function mix(a: Float32Array, b: Float32Array): Float32Array {
  const out = Float32Array.from(a.length >= b.length ? a : b), other = a.length >= b.length ? b : a
  for (let i = 0; i < other.length; i++) out[i] += other[i]
  return out
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/** Feeds a signal in 128-sample blocks (as a worklet does) and records every boundary with the sample it fell on. */
function run(core: VadCore, x: Float32Array, block = 128): { at: number; speech: boolean }[] {
  const out: { at: number; speech: boolean }[] = []
  for (let i = 0; i < x.length; i += block) {
    core.push(x, i, Math.min(block, x.length - i))
    if (core.changed) out.push({ at: i, speech: core.speech })
  }
  return out
}

test('the constructor takes the tuning, rounds the frame to a power of two, and refuses nonsense', () => {
  const c = new VadCore(VAD)
  assert.equal(c.frame, 512)
  assert.equal(new VadCore({ frame: 500 }).frame, 512)
  assert.equal(new VadCore({ frame: 1000 }).frame, 1024)
  assert.equal(new VadCore({ frame: -5, energyRatio: 0, onsetFrames: 0, floorRise: 0.5 } as never).frame, 64)
  const d = new VadCore({ energyRatio: 0, onsetFrames: 0, floorRise: 0.5 } as never)
  assert.deepEqual([d.energyRatio, d.onsetFrames, d.floorRise], [2.5, 4, 1.004])
})

test('a quiet room is never speech; the level follows the room and the floor settles on it', () => {
  const c = new VadCore(VAD)
  const changes = run(c, room(3))
  assert.deepEqual(changes, [])
  assert.equal(c.speech, false)
  assert.ok(c.frames > 250, `${c.frames} frames`)
  assert.ok(c.rms > 0.001 && c.rms < 0.006, `level ${c.rms}`)
  assert.ok(c.floor >= VAD.floor && c.floor < 0.006, `floor ${c.floor}`)
})

test('a voice over the room starts speech after the onset frames, survives a short pause, and ends after the release', () => {
  const c = new VadCore(VAD)
  const signal = concat(room(1), voice(0.8), room(0.15), voice(0.5), room(1.5))
  const changes = run(c, signal)
  assert.equal(changes.length, 2, JSON.stringify(changes))
  const [start, end] = changes
  assert.equal(start.speech, true)
  assert.equal(end.speech, false)
  // Started within the onset (4 frames of 512) plus a block of the voice beginning at 1 s.
  const voiceAt = SR
  assert.ok(start.at >= voiceAt && start.at <= voiceAt + VAD.onsetFrames * VAD.frame + 2 * VAD.frame, `started at ${start.at - voiceAt} samples in`)
  // Ended after the release (24 frames) past the second voice's end at 1 + 0.8 + 0.15 + 0.5 s; the 150 ms pause was kept.
  const voiceEnd = Math.round(2.45 * SR)
  assert.ok(end.at >= voiceEnd + (VAD.releaseFrames - 1) * VAD.frame && end.at <= voiceEnd + (VAD.releaseFrames + 3) * VAD.frame, `ended ${end.at - voiceEnd} samples after`)
})

test('hiss at a voice\'s level is not speech: loud, but neither voiced nor tonal', () => {
  const c = new VadCore(VAD)
  const changes = run(c, concat(room(1), hiss(1.5), room(0.5)))
  assert.deepEqual(changes, [], 'hiss')
  const f = c.features()
  assert.ok(f.zcr > VAD.zcrMax || f.flatness < VAD.flatnessMin, `zcr ${f.zcr} flatness ${f.flatness}`)
})

test('a voice that never stops becomes the room only slowly: the floor rises a little per silent frame, a quarter of that during speech', () => {
  const c = new VadCore(VAD)
  run(c, concat(room(1), voice(4)))
  assert.equal(c.speech, true, 'four seconds of voice is still speech')
  assert.ok(c.floor < 0.01, `the floor stayed near the room: ${c.floor}`)
})

test('a steady voiced hum that starts speech becomes the room within seconds instead of reading as a voice for ever', () => {
  for (const level of [0.006, 0.01]) {
    const c = new VadCore(VAD)
    const changes = run(c, concat(room(1, 0.002), hum(12, level)))
    assert.equal(changes[0]?.speech, true, `the hum at ${level} reads as a voice at first`)
    assert.equal(c.speech, false, `twelve seconds later it is the room: floor ${c.floor}`)
    const end = changes.find((x) => !x.speech)
    assert.ok(end && end.at < SR * 11, `released at ${end ? (end.at / SR).toFixed(1) : '-'} s`)
  }
})

test('Sloane\'s own voice back through the speakers is not the visitor\'s: her line\'s start only learns its level, and a visitor louder than it still barges in', () => {
  const c = new VadCore(VAD)
  run(c, room(1))
  c.speaking = true
  // Her echo, well over the room and the speaking margin (0.05 against a floor near 0.003), starts nothing; the
  // learning covers her line's first 1.5 s (echoWait) and 0.43 s (echoFrames) after the last steady sound in them.
  assert.deepEqual(run(c, voice(2.2, 0.05, 41)), [], 'her echo is not speech')
  assert.ok(c.echo > 0.03, `her echo was learned: ${c.echo}`)
  // The visitor, louder than her echo by more than the ratio, starts speech while she still speaks.
  const over = run(c, voice(0.6, 0.2, 43))
  assert.equal(over[0]?.speech, true, 'a clear voice over her line barges in')
  // A line that ends forgets her echo.
  c.speaking = false
  run(c, room(0.05))
  assert.deepEqual([c.echo, c.speakFrames], [0, 0])
})

test('a visitor\'s voice rising over tens of milliseconds still barges in, over her continuing echo and with none at all (headphones), and is never learned as her echo', () => {
  for (const ms of [40, 80, 120]) {
    // Headphones, or echo cancellation that works: nothing of her comes back (past her line's first 1.5 s, where a
    // visitor's voice is learned as hers).
    const quiet = new VadCore(VAD)
    run(quiet, room(1))
    quiet.speaking = true
    assert.deepEqual(run(quiet, room(1.6)), [], 'her line, inaudible here')
    const visitor = run(quiet, onset(voice(0.8, 0.05, 43), ms))
    assert.equal(visitor[0]?.speech, true, `no echo, a ${ms} ms onset: barges in`)
    // Speakers: her echo goes on under the visitor's words.
    const loud = new VadCore(VAD)
    run(loud, room(1))
    loud.speaking = true
    run(loud, voice(2.2, 0.05, 41))
    const over = run(loud, mix(voice(0.8, 0.05, 45), onset(voice(0.8, 0.2, 43), ms)))
    assert.equal(over[0]?.speech, true, `her echo going on, a ${ms} ms onset: barges in`)
    assert.ok(loud.speaking && loud.echo < 0.1, `the estimate stayed near her echo, not the visitor's level: ${loud.echo}`)
  }
})

test('her own line in syllables never cuts itself: pauses between sentences, a late start, a room\'s reverberation, her voice 3 dB louder at the end, and a click or a murmur before her voice', () => {
  // Her loudest echo holds through a pause and a quiet stretch (echoHold), so her next stressed word is never over the
  // bar; a steady tone could not show it (the second review's design passed one and cut her own speech). A click, or a
  // quieter voiced sound, before a voice that starts late is not taken for her (the fourth review's case: the learning
  // used to start at the first sound of any kind and end before her voice came).
  const cut: string[] = []
  let lines = 0
  const before = { none: () => new Float32Array(0), click: (seed: number) => concat(room(0.05, 0.003, seed + 70), click(0.03 + 0.01 * (seed % 3))), murmur: (seed: number) => concat(room(0.1, 0.003, seed + 70), voice(0.12, 0.01, seed + 80)) }
  for (const [what, lead] of Object.entries(before)) for (const sigmaDb of what === 'none' ? [0, 3, 4] : [3]) for (const pause of [0.3, 1.2]) for (const lag of [0, 0.6, 1, 1.3]) for (const louder of [1, 1.41]) for (const seed of [1, 2, 3]) {
    const c = new VadCore(VAD)
    run(c, room(1, 0.003, seed + 50))
    c.speaking = true
    const first = lead(seed)
    const line = concat(first, room(Math.max(0, lag - first.length / SR), 0.003, seed + 60), syllables(seed, { peak: 0.05, sentences: 4, pause, sigmaDb, louder, rt60: 0.4 }))
    lines++
    if (run(c, line).length > 0) cut.push(`${what} σ${sigmaDb} pause ${pause} lag ${lag} louder ${louder} seed ${seed}`)
  }
  assert.equal(lines, 144 + 48 + 48)
  assert.deepEqual(cut, [], 'her own line started speech')
})

test('a visitor talking over her line in syllables barges in within a second, always with none of her coming back and often over her echo, and never before they speak', () => {
  // With none of her coming back (headphones) the onset is short, so a quieter voice (0.02 at a syllable's crest, about
  // 17 dB over the room) cuts in too, and a click in her first 1.5 s (shorter than three frames) is not learned as her
  // voice. Over her echo without echo cancellation it is a trade: the bar that never lets her own line cut itself
  // (above) lets a visitor 12 to 14 dB over her usual words through within a second only about half the time (13 of
  // these 24 at this tuning, 5 of 12 at 12 dB and 8 of 12 at 14 dB; the rest later or not at all, as her estimate
  // creeps up under their words).
  const results: { kind: string; ok: boolean; early: boolean }[] = []
  const headphones = (seed: number, clicked: boolean): Float32Array => clicked ? over(room(7, 0.003, seed), click(0.1, 8, seed), Math.round(0.6 * SR)) : room(7, 0.003, seed)
  for (const [her, visitor, clicked] of [[0, 0.05, false], [0, 0.02, false], [0, 0.05, true], [0.05, 0.2, false], [0.03, 0.15, false]] as const) for (const when of [2, 3.5]) for (const seed of [1, 2, 3, 4, 5, 6]) {
    const c = new VadCore(VAD)
    run(c, room(1, 0.003, seed + 50))
    c.speaking = true
    const line = her > 0 ? syllables(seed, { peak: her, sentences: 3, pause: 0.5 }) : headphones(seed, clicked)
    const at = Math.round(SR * (when + (seed % 5) * 0.07))
    const heard = run(c, over(line, syllables(seed + 100, { peak: visitor, sentences: 1, pause: 0, f0: 210 }), at))
    const first = heard.find((x) => x.speech)
    results.push({ kind: `${her}/${visitor}${clicked ? ' click' : ''}@${when}`, ok: first !== undefined && first.at >= at && first.at - at < SR, early: first !== undefined && first.at < at })
  }
  assert.deepEqual(results.filter((x) => x.early), [], 'speech never starts before the visitor speaks')
  assert.deepEqual(results.filter((x) => x.kind.startsWith('0/') && !x.ok).map((x) => x.kind), [], 'with none of her coming back (headphones), every visitor barges in within a second')
  const echoed = results.filter((x) => !x.kind.startsWith('0/'))
  assert.equal(echoed.length, 24)
  assert.ok(echoed.filter((x) => x.ok).length >= 10, `over her echo, many barge in within a second: ${echoed.filter((x) => x.ok).length} of 24`)
})

test('a knock or a click of up to three frames (32 ms), wherever it falls across the frames, is not learned as her voice: with headphones a visitor still cuts in within a second', () => {
  // The fifth review's case: the steady level was the quietest of three frames, so a sound over a little more than one
  // frame touched all three and was learned; a 22 ms tap on the desk then shut a headphones visitor out for seconds.
  const late: string[] = []
  for (const ms of [12, 16, 20, 24, 28, 31]) for (const shift of [0, 64, 128, 192, 256, 320, 384, 448]) {
    const seed = 1 + ((ms + shift) % 3)
    const n = Math.round((ms / 1000) * SR), r = noise(seed + 900), knock = new Float32Array(n)
    for (let i = 0; i < n; i++) knock[i] = r() * 0.1 * Math.sqrt(3)
    const c = new VadCore(VAD)
    run(c, room(1, 0.003, seed + 50))
    c.speaking = true
    run(c, over(room(1.9, 0.003, seed), knock, Math.round(0.6 * SR) + shift))
    assert.ok(c.echo < c.floor * c.energyRatio, `a ${ms} ms knock at +${shift} is not her echo: ${c.echo}`)
    const heard = run(c, over(room(2, 0.003, seed + 1), syllables(seed + 100, { peak: 0.05, sentences: 1, pause: 0, f0: 210 }), Math.round(0.1 * SR)))
    const first = heard.find((x) => x.speech)
    if (first === undefined || first.at - Math.round(0.1 * SR) >= SR) late.push(`${ms} ms at +${shift}`)
  }
  assert.deepEqual(late, [], 'the visitor did not cut in within a second')
})

test('the frame follows the sample rate (vadFrame), so a frame lasts 10.7 to 11.6 ms and every count of frames is the time it says: at 88.2 and 96 kHz a knock of up to 32 ms is not learned and her learning still lasts about 1.5 s', () => {
  const frames = [16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000, 176_400, 192_000].map(vadFrame)
  assert.deepEqual(frames, [128, 256, 256, 256, 512, 512, 1024, 1024, 2048, 2048])
  assert.deepEqual([vadFrame(0), vadFrame(Number.NaN), vadFrame(-1), vadFrame(8_000), vadFrame(1e7)], [512, 512, 512, 128, 4096])
  for (const rate of [22_050, 24_000, 44_100, 48_000, 88_200, 96_000, 176_400, 192_000]) {
    const ms = (vadFrame(rate) / rate) * 1000
    assert.ok(ms >= 10.6 && ms <= 11.7, `${rate} Hz: a frame is ${ms.toFixed(1)} ms`)
    const wait = (VAD.echoWait * vadFrame(rate)) / rate
    assert.ok(wait > 1.4 && wait < 1.7, `${rate} Hz: her learning lasts ${wait.toFixed(2)} s`)
  }
  // The sixth review's case: at 96 kHz with 512-sample frames, a 22 ms tap touched five 5.3 ms frames and was learned.
  for (const rate of [88_200, 96_000]) for (const ms of [20, 24, 31]) for (const shift of [0, 256, 512, 768]) {
    const at = (seconds: number): number => Math.round(seconds * rate)
    const len = (seconds: number): number => (seconds * rate) / SR
    const n = Math.round((ms / 1000) * rate), r = noise(ms + shift), knock = new Float32Array(n)
    for (let i = 0; i < n; i++) knock[i] = r() * 0.1 * Math.sqrt(3)
    const c = new VadCore({ ...VAD, frame: vadFrame(rate) })
    run(c, room(len(1), 0.003, 51))
    c.speaking = true
    run(c, over(room(len(1.4), 0.003, 52), knock, at(0.6) + shift))
    assert.ok(c.echo < c.floor * c.energyRatio, `${rate} Hz, a ${ms} ms knock at +${shift}: not her echo (${c.echo})`)
  }
})

test('a line that cuts the one still playing (no edge of speaking) learns her echo afresh: a voice that changed is not cut, and nobody cuts in during its first 1.5 s', () => {
  // The fifth review's case: the speaker keeps speaking true across a cut, so the second line used to run on the first
  // one's count, with no learning of its own. A provider's line that echo cancellation takes out, cut by the operating
  // system's voice that comes back, then cut itself.
  const lines = (fresh: boolean, seed: number): { at: number; speech: boolean }[] => {
    const c = new VadCore(VAD)
    run(c, room(1, 0.003, seed + 50))
    c.speaking = true
    run(c, room(3, 0.003, seed))
    if (fresh) c.newLine()
    return run(c, concat(room(0.3, 0.003, seed + 60), syllables(seed, { peak: 0.05, sentences: 3, pause: 0.5, rt60: 0.4 })))
  }
  for (const seed of [1, 2, 3, 4]) {
    assert.deepEqual(lines(true, seed), [], `seed ${seed}: her new voice is learned, not cut`)
    assert.equal(lines(false, seed)[0]?.speech, true, `seed ${seed}: run on the old line's count, it cut itself`)
  }
  // Headphones on both lines, the visitor 0.3 s into the second: learned as her, as in any line's first 1.5 s.
  const c = new VadCore(VAD)
  run(c, room(1, 0.003, 51))
  c.speaking = true
  run(c, room(3, 0.003, 1))
  c.newLine()
  assert.deepEqual(run(c, over(room(1.5, 0.003, 2), syllables(101, { peak: 0.05, sentences: 1, pause: 0, f0: 210 }), Math.round(0.3 * SR))), [], 'nobody cuts in during its first 1.5 s')
  assert.equal(c.speakFrames > 0 && c.heardAt > 0, true)
})

test('while the page is speaking, the bar is higher: a quiet voice that would start speech does not; a clear one does, after a longer onset over her echo and a shorter one with none of her coming back', () => {
  // Past her line's first 1.5 s (echoWait), where a voice is learned as hers whatever its level.
  const quiet = concat(room(1.6), voice(1, 0.009))
  const a = new VadCore(VAD)
  assert.equal(run(a, quiet).length, 1, 'a quiet voice over a quiet room is speech when nothing else is playing')
  const b = new VadCore(VAD)
  b.speaking = true
  assert.deepEqual(run(b, quiet), [], 'the same voice under the speaking margin is not')
  const at = Math.round(1.6 * SR)
  const onsetAt = (changes: { at: number }[]): number => Math.round((changes[0].at - at) / VAD.frame)
  // None of her comes back: onsetFrames × quietOnset.
  const c = new VadCore(VAD)
  c.speaking = true
  const plain = run(c, concat(room(1.6), voice(1)))
  assert.equal(plain.length, 1)
  assert.ok(onsetAt(plain) >= VAD.onsetFrames * VAD.quietOnset - 1 && onsetAt(plain) < VAD.onsetFrames * VAD.speakingOnset - 1, `the quiet onset: ${onsetAt(plain)} frames`)
  // Her echo comes back: onsetFrames × speakingOnset.
  const d = new VadCore(VAD)
  run(d, room(1))
  d.speaking = true
  const echoed = run(d, concat(voice(2.2, 0.03, 41), mix(voice(1, 0.03, 45), voice(1, 0.2, 43))))
  assert.equal(echoed.length, 1)
  const over = Math.round((echoed[0].at - 2.2 * SR) / VAD.frame)
  assert.ok(over >= VAD.onsetFrames * VAD.speakingOnset - 1, `the onset lengthened over her echo: ${over} frames`)
})

test('push takes any block size and any offset, ignores NaN and infinities, and reset forgets everything', () => {
  const a = new VadCore(VAD), b = new VadCore(VAD)
  const signal = concat(room(0.5), voice(0.6), room(0.8))
  const fine = run(a, signal, 37)
  const coarse = run(b, signal, 4096)
  assert.equal(fine.length, 2)
  assert.equal(coarse.length, 2)
  assert.equal(a.frames, b.frames)
  const odd = new Float32Array(2048)
  odd.fill(Number.NaN, 0, 600)
  odd[700] = Number.POSITIVE_INFINITY
  odd[701] = Number.NEGATIVE_INFINITY
  const c = new VadCore(VAD)
  assert.equal(c.push(odd), 4)
  assert.equal(c.speech, false)
  assert.ok(Number.isFinite(c.rms) && Number.isFinite(c.floor))
  assert.equal(c.push(odd, 1000, 5000), 2, 'a length past the end is cut to it')
  run(c, voice(1))
  assert.equal(c.speech, true)
  c.reset()
  assert.deepEqual([c.speech, c.frames, c.rms, c.floor, c.fill, c.run], [false, 0, 0, VAD.floor, 0, 0])
})

test('the FFT: a pure tone lands in its bin and nowhere else; the flatness of white noise is near 0 dB, of a tone far below', () => {
  const n = 512
  const re = new Float32Array(n), im = new Float32Array(n)
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 8 * i) / n)
  VadCore.fft(re, im)
  const mag = (k: number) => Math.hypot(re[k], im[k])
  assert.ok(Math.abs(mag(8) - n / 2) < 1e-2, `bin 8: ${mag(8)}`)
  assert.ok(Math.abs(mag(n - 8) - n / 2) < 1e-2, `bin ${n - 8}: ${mag(n - 8)}`)
  for (let k = 0; k < n; k++) if (k !== 8 && k !== n - 8) assert.ok(mag(k) < 1e-2, `bin ${k}: ${mag(k)}`)
  const flat = new VadCore(VAD)
  flat.step(hiss(512 / SR, 0.1).subarray(0, 512))
  assert.ok(flat.flatness < 3, `white noise flatness ${flat.flatness} dB`)
  const tonal = new VadCore(VAD)
  tonal.step(voice(512 / SR, 0.1).subarray(0, 512))
  assert.ok(tonal.flatness > 10, `a harmonic voice ${tonal.flatness} dB below flat`)
})

test('the worklet module: VadCore by its runtime name, the processor registered under its name, and it detects speech in a stub scope', () => {
  const src = vadWorkletSource(VAD, 4)
  assert.ok(src.includes(`new ${VadCore.name}(`), 'the class by its own (possibly minified) name')
  assert.ok(src.includes(`registerProcessor(${JSON.stringify(VAD_PROCESSOR)}`))
  // A stub AudioWorkletGlobalScope: the module must run in it, register one processor, and that processor must post
  // a level a few times a second and every boundary.
  const registered: { name: string; ctor: new (o: unknown) => { process(inputs: Float32Array[][]): boolean; port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: unknown): void } } }[] = []
  class AudioWorkletProcessor { port = { onmessage: null as ((e: { data: unknown }) => void) | null, posted: [] as unknown[], postMessage(m: unknown) { this.posted.push(m) } } }
  const scope = {
    AudioWorkletProcessor,
    registerProcessor: (name: string, ctor: never) => { registered.push({ name, ctor }) },
    currentTime: 0.5,
  }
  const fn = new Function(...Object.keys(scope), src)
  fn(...Object.values(scope))
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, VAD_PROCESSOR)
  const p = new registered[0].ctor({ processorOptions: {} })
  const posted = (p.port as unknown as { posted: unknown[] }).posted
  const signal = concat(room(0.5), voice(0.6), room(0.8))
  for (let i = 0; i + 128 <= signal.length; i += 128) assert.equal(p.process([[signal.subarray(i, i + 128)]]), true)
  const boundaries = posted.filter((m) => typeof (m as { speech?: unknown }).speech === 'boolean') as { speech: boolean }[]
  assert.deepEqual(boundaries.map((b) => b.speech), [true, false])
  const levels = posted.filter((m) => typeof (m as { speech?: unknown }).speech !== 'boolean').length
  // 1.9 s is about 178 frames: a level every 4 frames is about 44 messages, far fewer than the 712 blocks.
  assert.ok(levels > 30 && levels < 60, `${levels} level messages`)
  // The page's commands: speaking raises the bar; a new line learns her echo afresh; reset forgets.
  p.port.onmessage?.({ data: { speaking: true } })
  const core = (p as unknown as { core: VadCore }).core
  for (let i = 0; i < 20; i++) p.process([[room(0.003, 0.003, 70 + i).subarray(0, 128)]])
  assert.ok(core.speaking && core.speakFrames > 0, 'speaking: her line\'s frames count')
  p.port.onmessage?.({ data: { line: true } })
  assert.deepEqual([core.speaking, core.speakFrames, core.echo, core.heardAt], [true, 0, 0, -1], 'a new line starts its count again')
  p.port.onmessage?.({ data: { reset: true } })
  assert.equal(p.process([[]]), true, 'no channel: nothing happens, the processor stays')
  assert.equal(p.process([]), true)
})
