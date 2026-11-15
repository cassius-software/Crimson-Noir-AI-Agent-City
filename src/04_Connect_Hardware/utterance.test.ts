// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the utterance tap (utterance.ts): a tone below 8 kHz comes out of
 * the resampler at 16 kHz with its frequency and its level, from 44.1, 48 and 96 kHz and from a 16 kHz stream as it
 * is; a tone above 8 kHz is taken out rather than folded over the voice; the number of samples out is the number the
 * rates say, however the blocks are cut; an utterance starts a lead before the detector said speech and ends a hang
 * after it said the room; speech that returns inside the hang stays in the same utterance; a click is dropped; a
 * speech longer than the cap is cut and goes on in the next; a reset forgets everything; odd input (NaN, an empty
 * block) never throws; counters far past 2^31 still give the same samples; and the class is self-contained, so it runs
 * from its own source text as the worklet runs it.
 * What breaks if it is removed? A change to the resampler could fold hiss over every sentence, or shift what the
 * recogniser reads by a block, and the recogniser would only seem to have got worse at hearing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UTTERANCE, UtteranceTap, utteranceOptions, utteranceSeconds, type UtteranceOptions } from './utterance.ts'

/** `seconds` of a sine at `hz` and `amp`, at `rate`. */
function tone(hz: number, seconds: number, rate: number, amp = 0.5): Float32Array {
  const n = Math.round(seconds * rate), out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate)
  return out
}

function rms(x: ArrayLike<number>, from = 0, to = x.length): number {
  let s = 0
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, to - from))
}

/** The strongest frequency of `x` at `rate`, by counting zero crossings (good enough for one clean tone). */
function pitch(x: ArrayLike<number>, rate: number, from = 0, to = x.length): number {
  let crossings = 0
  for (let i = from + 1; i < to; i++) if ((x[i] >= 0) !== (x[i - 1] >= 0)) crossings++
  return (crossings * rate) / (2 * (to - from - 1))
}

/** Feeds `x` in blocks of `block`, speech on throughout, with a tap that keeps everything (a lead longer than a block, a long cap). */
function resample(x: Float32Array, inRate: number, block = 128): Float32Array {
  const tap = new UtteranceTap({ ...UTTERANCE, inRate, lead: 0.5, hang: 0.05, min: 0, max: 60 })
  const parts: Float32Array[] = []
  for (let i = 0; i < x.length; i += block) {
    const u = tap.push(x, i, Math.min(block, x.length - i), true)
    if (u) parts.push(u)
  }
  // The room, long enough for the hang to run out.
  const quiet = new Float32Array(Math.ceil(inRate * 0.2))
  const u = tap.push(quiet, 0, quiet.length, false)
  if (u) parts.push(u)
  assert.equal(parts.length, 1, 'one utterance')
  return parts[0]
}

test('a tone below 8 kHz comes out at 16 kHz with its frequency and its level, from every rate a browser runs at', () => {
  for (const inRate of [16_000, 22_050, 44_100, 48_000, 88_200, 96_000, 192_000]) {
    for (const hz of [200, 1_000, 3_400, 5_000]) {
      const out = resample(tone(hz, 1, inRate), inRate)
      // Past the filter's own length at the start, and before the quiet tail.
      const from = 1_600, to = 14_400
      assert.ok(Math.abs(pitch(out, 16_000, from, to) - hz) < hz * 0.01 + 2, `${hz} Hz from ${inRate}: ${pitch(out, 16_000, from, to).toFixed(1)} Hz`)
      const level = rms(out, from, to)
      assert.ok(Math.abs(level - 0.5 / Math.SQRT2) < 0.02, `${hz} Hz from ${inRate}: level ${level.toFixed(4)}`)
    }
  }
})

test('a tone above 8 kHz is taken out, not folded back over the voice', () => {
  for (const inRate of [44_100, 48_000, 96_000]) {
    for (const hz of [8_500, 9_000, 12_000, 15_000, 20_000]) {
      const out = resample(tone(hz, 1, inRate), inRate)
      const level = rms(out, 1_600, 14_400)
      // 0.5 in, under a five-hundredth of it out: 54 dB down or better.
      assert.ok(level < (0.5 / Math.SQRT2) * 0.002, `${hz} Hz from ${inRate} leaves ${level.toExponential(2)}`)
    }
  }
})

test('the samples out are the samples the rates say, and the same however the blocks are cut', () => {
  const x = tone(440, 0.75, 44_100)
  const a = resample(x, 44_100, 128)
  const b = resample(x, 44_100, 1)
  const c = resample(x, 44_100, 4_096)
  const d = resample(x, 44_100, 777)
  assert.equal(a.length, b.length)
  assert.equal(a.length, c.length)
  assert.equal(a.length, d.length)
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i], b[i], `sample ${i}, one at a time`)
    assert.equal(a[i], c[i], `sample ${i}, in large blocks`)
    assert.equal(a[i], d[i], `sample ${i}, in odd blocks`)
  }
  // 0.75 s of sound and the 0.05 s hang, less the filter's reach.
  assert.ok(Math.abs(utteranceSeconds(a) - 0.8) < 0.01, `${utteranceSeconds(a)} s`)
})

/** Runs `script` ([seconds, speech] pieces of a 300 Hz tone or silence) through a tap; returns the utterances and when each ended. */
function run(script: [number, boolean][], o: Partial<UtteranceOptions> = {}, inRate = 48_000): { out: Float32Array[]; at: number[]; cut: boolean[]; tap: UtteranceTap } {
  const tap = new UtteranceTap({ ...UTTERANCE, inRate, ...o })
  const out: Float32Array[] = [], at: number[] = [], cut: boolean[] = []
  let t = 0
  for (const [seconds, speech] of script) {
    const x = speech ? tone(300, seconds, inRate) : new Float32Array(Math.round(seconds * inRate))
    for (let i = 0; i < x.length; i += 128) {
      const u = tap.push(x, i, Math.min(128, x.length - i), speech)
      t += Math.min(128, x.length - i) / inRate
      if (u) { out.push(u); at.push(t); cut.push(tap.cut) }
    }
  }
  return { out, at, cut, tap }
}

test('an utterance starts a lead before speech and ends a hang after it', () => {
  const { out, at } = run([[1, false], [1, true], [1, false]])
  assert.equal(out.length, 1)
  // The lead (0.4 s), the speech (1 s) and the hang (0.35 s).
  assert.ok(Math.abs(utteranceSeconds(out[0]) - 1.75) < 0.02, `${utteranceSeconds(out[0])} s`)
  // It ended when the hang ran out, 0.35 s after the speech did.
  assert.ok(Math.abs(at[0] - 2.35) < 0.02, `ended at ${at[0]} s`)
  // The lead is the silence before, then the tone.
  assert.ok(rms(out[0], 0, 6_000) < 0.01, 'the lead is the room')
  assert.ok(rms(out[0], 7_200, 20_000) > 0.3, 'then the voice')
  assert.ok(rms(out[0], 23_500, out[0].length) < 0.01, 'then the hang')
})

test('speech that returns inside the hang stays in the same utterance; past it, a second one', () => {
  const joined = run([[0.5, false], [0.8, true], [0.3, false], [0.8, true], [1, false]])
  assert.equal(joined.out.length, 1, 'a 0.3 s pause is inside the 0.35 s hang')
  assert.ok(Math.abs(utteranceSeconds(joined.out[0]) - (0.4 + 0.8 + 0.3 + 0.8 + 0.35)) < 0.03)
  const apart = run([[0.5, false], [0.8, true], [0.6, false], [0.8, true], [1, false]])
  assert.equal(apart.out.length, 2, 'a 0.6 s pause ends it')
  // The second starts with the full lead too: the lead is kept while an utterance is open, so it holds the end of the
  // first's hang and the room since.
  assert.ok(Math.abs(utteranceSeconds(apart.out[1]) - (0.4 + 0.8 + 0.35)) < 0.03, `${utteranceSeconds(apart.out[1])} s`)
})

test('a word that starts in the last utterance\'s hang keeps its first sound: the lead runs while an utterance is open', () => {
  // Speech, 0.3 s of quiet, a quiet onset (0.1 s, a fifth of the level) the detector does not call speech, 0.1 s of
  // quiet, then speech. The first utterance ends 0.35 s after its speech, halfway through the onset: the onset started
  // while it was still open, and the second's lead (the 0.4 s before its speech) still holds it.
  const tap = new UtteranceTap({ ...UTTERANCE, inRate: 48_000 })
  const out: Float32Array[] = []
  const feed = (x: Float32Array, speech: boolean) => { for (let i = 0; i < x.length; i += 128) { const u = tap.push(x, i, Math.min(128, x.length - i), speech); if (u) out.push(u) } }
  feed(new Float32Array(24_000), false)
  feed(tone(300, 0.8, 48_000), true)
  feed(new Float32Array(Math.round(0.3 * 48_000)), false)
  const onset = tone(300, 0.1, 48_000).map((v) => v * 0.2)
  feed(onset, false) // the first one's hang runs out halfway through it
  feed(new Float32Array(Math.round(0.1 * 48_000)), false)
  feed(tone(300, 0.8, 48_000), true)
  feed(new Float32Array(48_000), false)
  assert.equal(out.length, 2)
  // The second: its lead (0.4 s), its speech (0.8 s) and its hang (0.35 s).
  assert.ok(Math.abs(utteranceSeconds(out[1]) - 1.55) < 0.02, `${utteranceSeconds(out[1])} s`)
  // Its lead is 0.2 s of the room, the onset (0.2 to 0.3 s, at its own quiet level, not the voice's), then the room.
  assert.ok(rms(out[1], 0, Math.round(0.18 * 16_000)) < 0.01, 'the room first')
  const onsetRms = rms(out[1], Math.round(0.21 * 16_000), Math.round(0.29 * 16_000))
  assert.ok(onsetRms > 0.03 && onsetRms < 0.15, `the onset is in the lead (rms ${onsetRms})`)
  assert.ok(rms(out[1], Math.round(0.32 * 16_000), Math.round(0.38 * 16_000)) < 0.01, 'the room between the onset and the speech')
  assert.ok(rms(out[1], Math.round(0.45 * 16_000), Math.round(1.1 * 16_000)) > 0.3, 'then the voice')
})

test('a click is dropped: under the least the detector must have said speech, nothing comes out', () => {
  assert.equal(run([[0.5, false], [0.3, true], [1, false]]).out.length, 0)
  assert.equal(run([[0.5, false], [0.45, true], [1, false]]).out.length, 1)
})

test('speech past the cap is cut there and goes on in the next utterance, nothing lost', () => {
  const { out, cut } = run([[0.5, false], [5, true], [1, false]], { max: 2 })
  assert.equal(out.length, 3)
  assert.deepEqual(cut, [true, true, false])
  // The first carries the lead and two seconds; the second as many samples, all speech; the third the rest and the hang.
  assert.equal(out[0].length, Math.round(0.4 * 16_000) + 2 * 16_000)
  assert.equal(out[1].length, out[0].length)
  const total = out.reduce((n, u) => n + u.length, 0)
  assert.ok(Math.abs(total / 16_000 - (0.4 + 5 + 0.35)) < 0.02, `${total / 16_000} s in all`)
  for (const u of out) assert.ok(rms(u, 7_000, 9_000) > 0.3)
})

test('full inside the hang, an utterance is cut and the hang runs on in the next piece', () => {
  // Lead 0.4 s + cap 2 s = 2.4 s; 1.8 s of speech and the hang reach it 0.2 s into the hang.
  const { out, cut, at } = run([[0.5, false], [1.8, true], [1, false]], { max: 2 })
  assert.equal(out.length, 2)
  assert.deepEqual(cut, [true, false])
  assert.equal(out[0].length, Math.round(0.4 * 16_000) + 2 * 16_000)
  // The closing piece is the rest of the hang (0.15 s), and it ends when the hang would have: 0.35 s after the speech.
  assert.ok(Math.abs(utteranceSeconds(out[1]) - 0.15) < 0.02, `${utteranceSeconds(out[1])} s`)
  assert.ok(Math.abs(at[1] - (0.5 + 1.8 + 0.35)) < 0.02, `ended at ${at[1]} s`)
  // Speech that comes back inside the rest of the hang stays in the same sentence.
  const back = run([[0.5, false], [1.8, true], [0.3, false], [0.8, true], [1, false]], { max: 2 })
  assert.deepEqual(back.cut, [true, false])
  assert.ok(Math.abs(utteranceSeconds(back.out[1]) - (0.1 + 0.8 + 0.35)) < 0.02, `${utteranceSeconds(back.out[1])} s`)
})

test('a cut sentence always gets its closing piece, however little of it is speech', () => {
  // 2.1 s of speech past a 2 s cap: the rest is 0.1 s of speech and the hang, under `min`, and still returned.
  const { out, cut } = run([[0.5, false], [2.1, true], [1, false]], { max: 2 })
  assert.equal(out.length, 2)
  assert.deepEqual(cut, [true, false])
  assert.ok(Math.abs(utteranceSeconds(out[1]) - (0.1 + 0.35)) < 0.02, `${utteranceSeconds(out[1])} s`)
  // And the next sentence is judged by `min` again: a click after it is dropped.
  const after = run([[0.5, false], [2.1, true], [1, false], [0.3, true], [1, false]], { max: 2 })
  assert.equal(after.out.length, 2)
})

test('a reset forgets what was held, and nothing is kept at all while nothing is pushed', () => {
  const { tap } = run([[0.5, false], [0.6, true]])
  assert.equal(tap.open, true)
  tap.reset()
  assert.equal(tap.open, false)
  assert.equal(tap.fill, 0)
  assert.equal(tap.leadFill, 0)
  assert.ok(tap.kept.every((v) => v === 0) && tap.lead.every((v) => v === 0) && tap.ring.every((v) => v === 0))
  // The room after a reset ends nothing: the speech before it is gone.
  const quiet = new Float32Array(48_000)
  assert.equal(tap.push(quiet, 0, quiet.length, false), null)
})

test('odd input never throws: NaN and infinities read as silence, an empty block and a short array do nothing wrong', () => {
  const tap = new UtteranceTap(utteranceOptions(48_000))
  const bad = new Float32Array(4_800).fill(Number.NaN)
  bad[10] = Infinity
  bad[11] = -Infinity
  assert.equal(tap.push(bad, 0, bad.length, true), null)
  assert.equal(tap.push(bad, 0, 0, true), null)
  assert.equal(tap.push(bad, 4_000, 9_999, true), null)
  const quiet = new Float32Array(48_000)
  const u = tap.push(quiet, 0, quiet.length, false)
  // Too little speech for an utterance; and whatever was kept is all finite.
  assert.equal(u, null)
  assert.ok(tap.kept.every((v) => Number.isFinite(v)))
  for (const o of [{}, { inRate: 0 }, { inRate: Number.NaN }, { rate: -1 }, { zeros: 0 }, { lead: -1, hang: -1, max: 0, min: -1 }]) {
    const t = new UtteranceTap(o)
    assert.ok(t.step > 0 && t.half >= 2 && t.kept.length > 0)
  }
  assert.equal(utteranceOptions(Number.NaN).inRate, UTTERANCE.inRate)
  assert.equal(utteranceOptions(44_100).inRate, 44_100)
})

test('counters far past 2^31 give the same samples: a page left open for days still hears', () => {
  const x = tone(500, 0.5, 48_000)
  const fresh = new UtteranceTap({ ...UTTERANCE, inRate: 48_000, lead: 0, hang: 0.05, min: 0 })
  const old = new UtteranceTap({ ...UTTERANCE, inRate: 48_000, lead: 0, hang: 0.05, min: 0 })
  // Three days of audio already taken, at a whole number of output samples so both stand at the same phase.
  const days = 3 * 24 * 3600
  old.taken = days * 48_000
  old.made = days * 16_000
  old.aim()
  assert.ok(old.taken > 2 ** 31)
  const quiet = new Float32Array(9_600)
  const a: number[] = [], b: number[] = []
  for (const [tap, into] of [[fresh, a], [old, b]] as const) {
    tap.push(x, 0, x.length, true)
    const u = tap.push(quiet, 0, quiet.length, false)
    assert.ok(u)
    for (const v of u) into.push(v)
  }
  assert.equal(a.length, b.length)
  // Past the filter's reach (the old tap's ring holds silence where the fresh one has no samples yet: the same).
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-6, `sample ${i}: ${a[i]} and ${b[i]}`)
})

test('the class runs from its own source text, as the worklet runs it', () => {
  const src = UtteranceTap.toString()
  // Nothing outside it but Math and the typed arrays: evaluated in a scope with only those, it still works.
  const make = new Function('Math', 'Float32Array', 'Number', 'Infinity', `return (${src})`) as (...a: unknown[]) => typeof UtteranceTap
  const Tap = make(Math, Float32Array, Number, Infinity)
  const tap = new Tap({ ...UTTERANCE, inRate: 48_000 })
  const x = tone(300, 1, 48_000)
  assert.equal(tap.push(x, 0, x.length, true), null)
  const quiet = new Float32Array(48_000)
  const u = tap.push(quiet, 0, quiet.length, false)
  assert.ok(u instanceof Float32Array && u.length > 16_000)
  // The code (its comments aside) names nothing a worklet scope lacks.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\b(?:window|document|performance|console|require|import|globalThis|self)\b/)
})
