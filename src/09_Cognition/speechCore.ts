// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the part of the page's own speech recogniser that is plain arithmetic: turning one
 * utterance (16 kHz samples, 04_Connect_Hardware/utterance.ts) into words with the speech pack's model
 * (speechPack.ts). The model is an encoder that reads the audio once and a decoder that writes one token at a time,
 * each from the one before; this file runs that loop (greedy: the likeliest token each step), keeps the decoder's
 * memory between steps so each costs the same, stops it at the end mark or at a length no sentence of that duration
 * reaches, and turns the tokens into text with the model's vocabulary. Before reading, it cuts an utterance to the part
 * that holds the words (the microphone keeps room around them, which this model reads as the end of a sentence). It
 * also decides what is not worth reading or repeating: an utterance too quiet or too short to be a word, and the two
 * ways a small model fails on a noise (it writes the same thing until it runs out of length, or it writes a sentence it
 * is not sure of at all).
 * It names no runtime: the sessions and tensors are passed in (SpeechRuntime), which the worker fills with ONNX
 * Runtime (speech.worker.ts) and a Node test with its own, so everything here runs under `node --test`.
 * What breaks if it is removed? The worker has a model and no way to read it: the microphone understands no words
 * where the browser has no recogniser of its own.
 */

/** A tensor as a runtime hands it back: its values and its shape. */
export interface TensorOut { readonly data: ArrayLike<number> | ArrayLike<bigint>; readonly dims: readonly number[] }

/** A loaded model half: its outputs' names, and one run from named inputs to named outputs. */
export interface SessionLike {
  readonly outputNames: readonly string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, TensorOut>>
}

/** What the loop needs of a runtime: the two sessions and the three kinds of tensor it feeds them. */
export interface SpeechRuntime {
  readonly encoder: SessionLike
  readonly decoder: SessionLike
  /** A float32 tensor of `dims` over `data`. */
  float(data: Float32Array, dims: readonly number[]): unknown
  /** An int64 tensor [1, 1] holding one token id. */
  token(id: number): unknown
  /** A bool tensor [1]. */
  flag(on: boolean): unknown
}

/** The model's shape and marks: what the decoder's memory looks like before the first step, and its special tokens. */
export interface SpeechShape {
  /** Decoder layers, attention heads, and each head's width: an empty memory is [0, heads, 1, width] per layer and kind. */
  readonly layers: number
  readonly heads: number
  readonly width: number
  /** The token the decoder starts from, and the one that ends a sentence. */
  readonly start: number
  readonly end: number
  /** The rate of the audio it reads. */
  readonly rate: number
}

/** Moonshine Tiny: six decoder layers, eight heads of 36, start `<s>` (1), end `</s>` (2), 16 kHz audio. */
export const SPEECH_SHAPE: SpeechShape = Object.freeze({ layers: 6, heads: 8, width: 36, start: 1, end: 2, rate: 16_000 })

/** The loop's limits and the reader's thresholds. */
export const SPEECH_LIMITS = Object.freeze({
  /** Seconds under which an utterance is not read at all, and over which it is read only up to here. */
  minSeconds: 0.3,
  maxSeconds: 30,
  /** Tokens a second of speech can hold (fast speech is about four words, six tokens): the loop stops there, so a
   *  noise the decoder would describe for ever costs a bounded time. Never under `floor` tokens. */
  tokensPerSecond: 6.5,
  floor: 8,
  /** The loudest sample under which an utterance is silence to the reader (about −54 dBFS). */
  quiet: 0.002,
  /** The decoder's mean certainty (the probability it gave each token it chose, geometric mean) under which what it
   *  wrote is a guess at a noise, not a reading of words. */
  sure: 0.35,
  /** A reading that ran into the length limit and ends in the same run of tokens this many times in a row is a decoder
   *  that lost the audio: the repeats are taken off and one copy is kept. Below the limit a repeat is never cut, since
   *  people repeat themselves on purpose ("no, no, no") and numbers repeat digits ("555"). */
  repeats: 3,
  /** The voiced part of an utterance: 20 ms frames whose loudness is over this share of the loud frames' (the third
   *  loudest, so one click does not set it) and over `quiet` are speech; the model reads from `margin` seconds before
   *  the first to `margin` after the last. 0.1 and 0.15 s read the most short commands of the shares and margins tried
   *  (57 of 60 recorded and synthesised commands, against 52 with a twentieth or a quarter-second margin). The
   *  microphone's tap keeps some 0.4 s of room before the words and 0.6 s after them (its lead, the detector's
   *  release and the hang), and with that much room around them this model often writes nothing at all for a short
   *  command: cut to the words, it reads them. */
  voicedShare: 0.1,
  margin: 0.15,
})

/** One reading: the text ('' when nothing worth saying was heard), why it was dropped if it was, and its numbers. */
export interface Reading {
  readonly text: string
  /** '' for a reading; else why there is no text: 'short', 'quiet', 'unsure', 'empty'. */
  readonly dropped: '' | 'short' | 'quiet' | 'unsure' | 'empty'
  /** The tokens written (before the vocabulary), the decoder's mean certainty, and whether the length limit stopped it
   *  (a looping tail there is cut back to one copy: loopCut). */
  readonly tokens: readonly number[]
  readonly sure: number
  readonly cut: boolean
  /** The utterance's length in seconds. */
  readonly seconds: number
}

const none = (dropped: Reading['dropped'], seconds: number): Reading => ({ text: '', dropped, tokens: [], sure: 0, cut: false, seconds })

/** The name of a layer's memory tensor, as the decoder's inputs name it. */
const pastName = (layer: number, half: 'decoder' | 'encoder', kind: 'key' | 'value'): string => `past_key_values.${layer}.${half}.${kind}`

/**
 * The likeliest entry of a step's scores, and the probability the model gave it (a softmax over the row, computed
 * from the top down so no exponent overflows).
 */
export function likeliest(logits: ArrayLike<number>, from = 0, to = logits.length): { id: number; p: number } {
  let best = from, top = -Infinity
  for (let i = from; i < to; i++) { const v = logits[i]; if (v > top) { top = v; best = i } }
  if (!(top > -Infinity)) return { id: from, p: 0 }
  let sum = 0
  for (let i = from; i < to; i++) { const v = logits[i]; if (v === v) sum += Math.exp(v - top) }
  return { id: best - from, p: sum > 0 ? 1 / sum : 0 }
}

/**
 * Where a run of tokens starts repeating: the length to keep when the tail is the same run `times` times over (the
 * first copy stays), else -1. A decoder that lost the audio writes "the the the" or one clause again and again.
 */
export function repeatCut(ids: readonly number[], times: number = SPEECH_LIMITS.repeats): number {
  const n = ids.length
  for (let len = 1; len * times <= n; len++) {
    let same = true
    for (let k = 1; k < times && same; k++) {
      for (let i = 0; i < len; i++) {
        if (ids[n - 1 - i] !== ids[n - 1 - i - k * len]) { same = false; break }
      }
    }
    if (same) return n - len * (times - 1)
  }
  return -1
}

/**
 * Where a reading that ran out of length should end: after the first copy of the run its tail repeats `times` times or
 * more, every copy after the first taken off. The last copy may be cut short by the limit (up to `ragged` tokens of
 * it), but only tokens that are the start of that run count as such: anything else after a repeat ("no, no, no." or
 * "1000 now") is a real ending and is kept. The earliest such end; -1 when the tail is not a loop.
 */
export function loopCut(ids: readonly number[], times: number = SPEECH_LIMITS.repeats, ragged = 8): number {
  let best = -1
  for (let d = 0; d <= ragged && d < ids.length; d++) {
    const m = ids.length - d
    for (let len = 1; len * times <= m; len++) {
      // The d tokens after m must be the run's first d tokens (a copy the limit cut short), and fewer than a copy.
      if (d > 0) {
        if (d >= len) continue
        let prefix = true
        for (let i = 0; i < d; i++) if (ids[m + i] !== ids[m - len + i]) { prefix = false; break }
        if (!prefix) continue
      }
      // Copies of the last `len` tokens before m, counted back while they match.
      let copies = 1
      for (;;) {
        const from = m - (copies + 1) * len
        if (from < 0) break
        let same = true
        for (let i = 0; i < len; i++) if (ids[m - 1 - i] !== ids[m - 1 - i - copies * len]) { same = false; break }
        if (!same) break
        copies++
      }
      if (copies < times) continue
      const end = m - (copies - 1) * len
      if (best < 0 || end < best) best = end
      break
    }
  }
  return best
}

/**
 * The part of an utterance that holds the words: from `margin` seconds before the first 20 ms frame whose loudness
 * (RMS) is over `voicedShare` of the third loudest frame's (and over `quiet`) to `margin` after the last, as a view of
 * the same samples. The whole utterance when no frame is that loud. A loud sound that is not speech (a knock on the
 * desk, a cough, a door) can set that bar over the words themselves; so the room's own level is measured too (the
 * quietest tenth of the frames: the microphone keeps room before and after the words), and when frames well over
 * the room (ROOM_RISE times it) lie outside the span for a tenth of a second or more, the span runs from the first
 * such frame to the last instead: the words are kept, with the noise.
 */
/** How far over the room's level (as a ratio of loudness, about 12 dB) a frame must be to count as sound in voicedSpan's check. */
const ROOM_RISE = 4

export function voicedSpan(samples: Float32Array, rate: number = SPEECH_SHAPE.rate, share: number = SPEECH_LIMITS.voicedShare, margin: number = SPEECH_LIMITS.margin): Float32Array {
  const frame = Math.max(1, Math.round(rate * 0.02))
  const frames = Math.floor(samples.length / frame)
  if (frames < 1) return samples
  const loud = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = f * frame, end = i + frame; i < end; i++) sum += samples[i] * samples[i]
    loud[f] = Math.sqrt(sum / frame)
  }
  // The third loudest frame (60 ms of sound), not the loudest: a click or a knock is one or two frames.
  const sorted = Float32Array.from(loud).sort()
  const top = sorted[Math.max(0, frames - 3)]
  const bar = Math.max(SPEECH_LIMITS.quiet, top * share)
  let first = -1, last = -1
  for (let f = 0; f < frames; f++) if (loud[f] > bar) { if (first < 0) first = f; last = f }
  if (first < 0) return samples
  // The room, and what stands well over it outside the span (with its margin): words a loud burst hid.
  const room = sorted[Math.floor(frames / 10)]
  const over = Math.max(SPEECH_LIMITS.quiet, room * ROOM_RISE)
  const near = Math.ceil(margin / 0.02)
  let outside = 0, wideFirst = first, wideLast = last
  for (let f = 0; f < frames; f++) {
    if (!(loud[f] > over)) continue
    if (f < first - near || f > last + near) outside++
    if (f < wideFirst) wideFirst = f
    if (f > wideLast) wideLast = f
  }
  if (outside >= 5) { first = wideFirst; last = wideLast }
  const pad = Math.round(margin * rate)
  const from = Math.max(0, first * frame - pad)
  const to = Math.min(samples.length, (last + 1) * frame + pad)
  return from === 0 && to === samples.length ? samples : samples.subarray(from, to)
}

/**
 * Reads one utterance: the encoder once, then the decoder a token at a time from the start mark until the end mark or
 * the length limit (where a repeating tail is taken off: loopCut). The limit is `tokensPerSecond` of `seconds` (the
 * utterance's own length, which may be longer than the part read), never under `floor`. Returns the tokens and the
 * certainty (the geometric mean of the probabilities of the tokens kept); `tokensText` makes them words. Throws only
 * what the runtime throws.
 */
export async function readTokens(rt: SpeechRuntime, samples: Float32Array, shape: SpeechShape = SPEECH_SHAPE, seconds: number = samples.length / shape.rate): Promise<{ tokens: number[]; sure: number; cut: boolean }> {
  const enc = await rt.encoder.run({ input_values: rt.float(samples, [1, samples.length]) })
  const hidden = enc.last_hidden_state ?? enc[rt.encoder.outputNames[0]]
  // The decoder's memory before the first step: nothing, in the shape it expects.
  const past: Record<string, unknown> = {}
  for (let l = 0; l < shape.layers; l++) {
    for (const half of ['decoder', 'encoder'] as const) {
      for (const kind of ['key', 'value'] as const) past[pastName(l, half, kind)] = rt.float(new Float32Array(0), [0, shape.heads, 1, shape.width])
    }
  }
  const limit = Math.max(SPEECH_LIMITS.floor, Math.trunc(seconds * SPEECH_LIMITS.tokensPerSecond))
  const tokens: number[] = []
  const logs: number[] = []
  let next = shape.start
  let cut = false
  for (let step = 0; ; step++) {
    if (step >= limit) {
      cut = true
      // Out of length: a decoder that lost the audio writes the same run again and again; one copy is kept.
      const keep = loopCut(tokens)
      if (keep >= 0) { tokens.length = keep; logs.length = keep }
      break
    }
    const out = await rt.decoder.run({ input_ids: rt.token(next), encoder_hidden_states: hidden, use_cache_branch: rt.flag(step > 0), ...past })
    const logits = out.logits
    // The scores of the last position: one row of the vocabulary.
    const vocab = logits.dims[logits.dims.length - 1]
    const data = logits.data as ArrayLike<number>
    const { id, p } = likeliest(data, data.length - vocab, data.length)
    if (id === shape.end) break
    tokens.push(id)
    logs.push(Math.log(Math.max(p, 1e-9)))
    next = id
    // What the decoder remembers of its own tokens grows each step; what it remembers of the audio is the same after
    // the first, so it is taken once (the model's merged graph passes it through thereafter).
    for (const name of rt.decoder.outputNames) {
      if (!name.startsWith('present')) continue
      const key = name.replace('present', 'past_key_values')
      if (step === 0 || key.includes('.decoder.')) past[key] = out[name]
    }
  }
  let sum = 0
  for (const l of logs) sum += l
  return { tokens, sure: tokens.length ? Math.exp(sum / tokens.length) : 0, cut }
}

/** The vocabulary: each token's piece of text by its id (third_party/moonshine-tiny-en/tokens.json). */
export type Vocabulary = readonly string[]

/** Parses the vocabulary file: one JSON array of strings; throws with the reason otherwise. */
export function parseVocabulary(text: string): Vocabulary {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    throw new Error('the speech vocabulary is not JSON')
  }
  if (!Array.isArray(v) || v.length < 259 || !v.every((x) => typeof x === 'string')) throw new Error('the speech vocabulary is not a list of pieces')
  return v as string[]
}

const BYTE = /^<0x([0-9A-Fa-f]{2})>$/

/**
 * Tokens as text: each piece in order, the word-start mark (U+2581) a space, a run of byte tokens (`<0xNN>`: how
 * the vocabulary spells what it has no piece for) decoded together as UTF-8, and the special tokens (the first three
 * and every id past the vocabulary) nothing. Spaces are single, the ends trimmed.
 */
export function tokensText(ids: readonly number[], vocab: Vocabulary): string {
  let out = ''
  let bytes: number[] = []
  const flush = (): void => {
    if (!bytes.length) return
    out += new TextDecoder('utf-8').decode(new Uint8Array(bytes))
    bytes = []
  }
  for (const id of ids) {
    if (!(id >= 3) || id >= vocab.length) continue
    const piece = vocab[id]
    const b = BYTE.exec(piece)
    if (b) { bytes.push(Number.parseInt(b[1], 16)); continue }
    flush()
    out += piece
  }
  flush()
  return out.replaceAll('▁', ' ').replace(/\s+/g, ' ').trim()
}

/** Whether text holds anything said: a letter or a digit, in any script. */
export const saysSomething = (text: string): boolean => /[\p{L}\p{N}]/u.test(text)

/** The loudest sample of an utterance (its absolute value). */
export function peak(samples: Float32Array): number {
  let m = 0
  for (let i = 0; i < samples.length; i++) { const v = samples[i] < 0 ? -samples[i] : samples[i]; if (v > m) m = v }
  return m
}

/**
 * One utterance as a Reading: too short or too quiet is not read; the rest is cut to its voiced part (voicedSpan) and
 * read; what the decoder wrote without being sure, or that says nothing, is dropped with the reason; else the text.
 * An utterance over `maxSeconds` is read up to there.
 */
export async function readUtterance(rt: SpeechRuntime, samples: Float32Array, vocab: Vocabulary, shape: SpeechShape = SPEECH_SHAPE): Promise<Reading> {
  const seconds = samples.length / shape.rate
  if (!(seconds >= SPEECH_LIMITS.minSeconds)) return none('short', seconds)
  if (!(peak(samples) >= SPEECH_LIMITS.quiet)) return none('quiet', seconds)
  const most = Math.round(SPEECH_LIMITS.maxSeconds * shape.rate)
  const voiced = voicedSpan(samples, shape.rate)
  const heard = voiced.length > most ? voiced.subarray(0, most) : voiced
  // The length limit counts the whole utterance, as long as it was (up to `maxSeconds`), not only the part read: a
  // fast "no, no, no, no" in under a second must not run into the floor.
  const { tokens, sure, cut } = await readTokens(rt, heard, shape, Math.min(seconds, SPEECH_LIMITS.maxSeconds))
  const text = tokensText(tokens, vocab)
  if (!saysSomething(text)) return { text: '', dropped: 'empty', tokens, sure, cut, seconds }
  if (sure < SPEECH_LIMITS.sure) return { text: '', dropped: 'unsure', tokens, sure, cut, seconds }
  return { text, dropped: '', tokens, sure, cut, seconds }
}

/**
 * Checks files against the SHA-256 each must have (`digest` gives a file's, in hex): a file that matches is held under
 * its role; one that does not is forgotten and named in the answer. Every file is checked, a bad one does not end the
 * round: the rest of what came with it is still held, so only the bad ones need to come again.
 */
export async function holdChecked<R>(held: Map<R, ArrayBuffer>, files: readonly { role: R; bytes: ArrayBuffer; sha256: string }[], digest: (bytes: ArrayBuffer) => Promise<string>): Promise<R[]> {
  const bad: R[] = []
  for (const f of files) {
    if ((await digest(f.bytes)) === f.sha256) {
      held.set(f.role, f.bytes)
    } else {
      held.delete(f.role)
      bad.push(f.role)
    }
  }
  return bad
}
