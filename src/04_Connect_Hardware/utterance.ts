// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It cuts what the microphone hears into utterances a speech recogniser can read: the
 * detector (vad.ts) says when a person starts and stops, and this keeps the samples between, from a little before the
 * start (the detector answers some tens of milliseconds late, and a word's first consonant is quiet) to a little after
 * the stop (a pause inside a sentence must not end it), already resampled to the 16 kHz the recogniser reads, whatever
 * rate the browser's audio runs at (44.1, 48 or 96 kHz, or a headset's 16). An utterance is a Float32Array held in
 * memory until the recogniser has read it and nothing more: it is never written anywhere, never sent anywhere, and the
 * tap keeps nothing at all unless the page asked it to hear (Microphone.hear). The same class runs inside the
 * detector's AudioWorklet beside VadCore (vad.ts vadWorkletSource serialises it the same way, by
 * Function.prototype.toString), so only 16 kHz utterances cross to the page, a few times a minute, and on the page
 * where the browser has no worklet. That is why UtteranceTap is self-contained: it reaches nothing outside itself but
 * Math and the typed arrays.
 * The resampler is a windowed-sinc low-pass read at the output's instants (a polyphase table of PHASES phases, so no
 * trigonometry runs on the audio thread): the band above the recogniser's 8 kHz is taken out before the rate drops,
 * which a plain every-third-sample pick would fold back over the voice.
 * What breaks if it is removed? The microphone still shows its level and its speech state, and no speech recogniser
 * of the page's own has anything to read: only a browser's own recogniser, where one exists, hears words.
 */

/** The tap's tuning (UtteranceTap takes a copy; the worklet gets it as processorOptions.tap). */
export const UTTERANCE = Object.freeze({
  /** The rate utterances are delivered at: what the recogniser's model was trained on. */
  rate: 16_000,
  /** The rate the samples arrive at (the page passes its audio context's). */
  inRate: 48_000,
  /** Seconds kept from before the detector said speech: its onset count (about 43 ms) and a word's quiet first sound. */
  lead: 0.4,
  /** Seconds the tap keeps listening after the detector said the room again (which it says about a quarter of a second
   *  after the last sound): speech that returns within them (a breath, a pause between two clauses) goes on in the
   *  same utterance, so a sentence is one utterance and not three. */
  hang: 0.35,
  /** Seconds at which an utterance is cut and handed over while the person still speaks (the rest starts the next):
   *  the recogniser reads short sentences best, and the page never holds more than this. */
  max: 12,
  /** Seconds the detector must have said speech, under which what was caught is dropped. The detector holds speech for
   *  about a quarter of a second after the last sound, so this asks for some 0.15 s of sound itself: a click or a chair
   *  is dropped, a "yes" is kept. */
  min: 0.4,
  /** Zero crossings of the low-pass kept each side of an output instant: 16 passes a voice whole up to about 5.5 kHz
   *  and leaves under a five-hundredth of anything above 8.5 kHz (about a hundred taps at 48 kHz). */
  zeros: 16,
})

export type UtteranceOptions = { [K in keyof typeof UTTERANCE]: number }

/**
 * The tap. Feed it every block the detector got, with the detector's speech state after that block (`push`); it
 * returns an utterance (a fresh Float32Array at `rate`) when one ended in that block, else null. Self-contained on
 * purpose (see the file comment): nothing outside it but Math and the typed arrays.
 */
export class UtteranceTap {
  readonly rate: number
  readonly inRate: number
  /** Input samples per output sample. */
  readonly step: number
  /** Taps each side of an output instant, and phases of the table between two input samples. */
  readonly half: number
  readonly phases: number
  /** The low-pass, one row of 2 * half + 1 taps per phase, each row summing to one. */
  readonly table: Float32Array
  /** The newest input samples, a ring a little longer than one row of taps. */
  readonly ring: Float32Array
  /** Input samples taken since the last reset, and output samples made. Counted as numbers, never through a bitwise
   *  operator: a page left open with its microphone on passes 2^31 samples in half a day. */
  taken = 0
  made = 0
  /** The next output instant: the whole input sample it stands on, and the row of the table for its fraction. */
  at = 0
  row = 0
  /** The lead: the newest output samples while no utterance is open, a ring. */
  readonly lead: Float32Array
  leadAt = 0
  leadFill = 0
  /** The utterance being kept, how much of it is filled, and whether one is open. */
  readonly kept: Float32Array
  fill = 0
  open = false
  /** Output samples since the detector last said speech, while an utterance is open (the hang runs on it). */
  quiet = 0
  /** Output samples of the open utterance that came while the detector said speech. */
  voiced = 0
  readonly hangSamples: number
  readonly minSamples: number
  /** Whether the utterance last returned was cut at `max` (the person was still speaking). */
  cut = false

  constructor(o: Partial<UtteranceOptions> = {}) {
    const rate = Number(o.rate) > 0 ? Math.round(Number(o.rate)) : 16_000
    const inRate = Number(o.inRate) > 0 ? Number(o.inRate) : 48_000
    this.rate = rate
    this.inRate = inRate
    this.step = inRate / rate
    const zeros = Number(o.zeros) >= 2 ? Math.round(Number(o.zeros)) : 16
    // The low-pass turns over a little under half the lower of the two rates (cycles per input sample).
    const cutoff = (0.4375 * Math.min(inRate, rate)) / inRate
    const half = Math.max(2, Math.min(1024, Math.ceil(zeros / (2 * cutoff))))
    const phases = 64
    this.half = half
    this.phases = phases
    const width = 2 * half + 1
    const table = new Float32Array(phases * width)
    for (let p = 0; p < phases; p++) {
      const frac = p / phases
      let sum = 0
      for (let k = 0; k < width; k++) {
        // The tap at input offset (k − half) from the instant's whole sample, the instant itself `frac` past it.
        const t = k - half - frac
        const x = 2 * cutoff * t
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
        const edge = t / (half + 1)
        // A Blackman window over the taps: its side lobes are what keep the folded band far down.
        const w = edge <= -1 || edge >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * edge) + 0.08 * Math.cos(2 * Math.PI * edge)
        const v = sinc * w
        table[p * width + k] = v
        sum += v
      }
      for (let k = 0; k < width; k++) table[p * width + k] /= sum
    }
    this.table = table
    this.ring = new Float32Array(width + 64)
    const lead = Number(o.lead) >= 0 ? Number(o.lead) : 0.4
    const hang = Number(o.hang) >= 0 ? Number(o.hang) : 0.35
    const max = Number(o.max) > 0 ? Number(o.max) : 12
    const min = Number(o.min) >= 0 ? Number(o.min) : 0.4
    this.lead = new Float32Array(Math.max(1, Math.round(lead * rate)))
    this.hangSamples = Math.round(hang * rate)
    this.minSamples = Math.round(min * rate)
    this.kept = new Float32Array(this.lead.length + Math.max(rate, Math.round(max * rate)))
  }

  /**
   * Takes `length` samples of `x` from `offset`, with the detector's speech state after them. Returns the utterance
   * that ended in them (speech stopped and the hang ran out, or `max` was reached: `cut` then), else null. Blocks are
   * a few milliseconds, so at most one utterance ends in one; never throws on odd input.
   */
  push(x: ArrayLike<number>, offset: number, length: number, speech: boolean): Float32Array | null {
    const ring = this.ring, size = ring.length, half = this.half, width = 2 * half + 1, table = this.table
    let out: Float32Array | null = null
    // The detector's word for this block: speech opens an utterance, starting from the lead (what came before it).
    if (speech && !this.open) {
      const lead = this.lead, n = this.leadFill, cap = lead.length
      for (let k = 0; k < n; k++) this.kept[k] = lead[(this.leadAt - n + k + cap) % cap]
      this.fill = n
      this.open = true
      this.quiet = 0
      this.voiced = 0
      this.leadFill = 0
    }
    let end = offset + length
    if (!(end <= x.length)) end = x.length
    for (let i = offset; i < end; i++) {
      const v = x[i]
      ring[this.taken % size] = v === v && v < Infinity && v > -Infinity ? v : 0
      this.taken++
      // Every output instant whose taps have all arrived (the last of them is input sample at + half).
      while (this.at + half < this.taken) {
        const first = this.at - half
        // Before the stream's first sample there is nothing: those taps read as silence.
        let k = first < 0 ? -first : 0
        let j = (first + k) % size
        let sum = 0
        const row = this.row
        for (; k < width; k++) {
          sum += ring[j] * table[row + k]
          if (++j === size) j = 0
        }
        this.made++
        this.aim()
        const done = this.sample(sum, speech)
        if (done !== null && out === null) out = done
      }
    }
    return out
  }

  /** Works out where the next output instant stands: its whole input sample and its fraction's row of the table. */
  aim(): void {
    const t = this.made * this.step
    let at = Math.floor(t)
    let phase = Math.round((t - at) * this.phases)
    if (phase === this.phases) { phase = 0; at++ }
    this.at = at
    this.row = phase * (2 * this.half + 1)
  }

  /** One output sample: into the open utterance (ending it at `max`, or once the hang ran out), else into the lead. */
  sample(v: number, speech: boolean): Float32Array | null {
    if (!this.open) {
      const lead = this.lead
      lead[this.leadAt] = v
      this.leadAt = (this.leadAt + 1) % lead.length
      if (this.leadFill < lead.length) this.leadFill++
      return null
    }
    this.kept[this.fill++] = v
    if (speech) { this.quiet = 0; this.voiced++ } else this.quiet++
    if (this.fill >= this.kept.length) return this.finish(true)
    if (this.quiet >= this.hangSamples) return this.finish(false)
    return null
  }

  /** Ends the open utterance: a copy of it when enough of it was voiced, else null. A cut goes straight on in the next. */
  finish(cut: boolean): Float32Array | null {
    const enough = this.voiced >= this.minSamples
    const out = enough ? this.kept.slice(0, this.fill) : null
    if (out !== null) this.cut = cut
    this.fill = 0
    this.quiet = 0
    this.voiced = 0
    this.open = cut
    return out
  }

  /** Forgets everything held: for a new stream, or when the page stops hearing. */
  reset(): void {
    this.taken = 0
    this.made = 0
    this.at = 0
    this.row = 0
    this.leadAt = 0
    this.leadFill = 0
    this.fill = 0
    this.open = false
    this.quiet = 0
    this.voiced = 0
    this.cut = false
    this.ring.fill(0)
    this.lead.fill(0)
    this.kept.fill(0)
  }
}

/** The tap's options for an audio context's rate. */
export function utteranceOptions(inRate: number): UtteranceOptions {
  const r = Number(inRate)
  return Object.freeze({ ...UTTERANCE, inRate: Number.isFinite(r) && r > 0 ? r : UTTERANCE.inRate })
}

/** How long an utterance is, in seconds. */
export function utteranceSeconds(samples: Float32Array, rate: number = UTTERANCE.rate): number {
  return samples.length / rate
}
