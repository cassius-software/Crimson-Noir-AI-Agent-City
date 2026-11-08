// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the voice activity detector behind the microphone pill: pure maths that decides,
 * frame by frame, whether the microphone hears a person speaking or the room, so the page can show "Hearing you",
 * cut Sloane's voice short when the visitor talks over it (barge-in), and never treat a passing bus as a sentence. It
 * is the classic three-feature detector (energy over an adaptive noise floor, the zero-crossing rate, and the spectral
 * flatness of a 512-point frame: speech is louder than the room, not hissy, and harmonic), with an onset count before
 * speech starts and a release count before it ends, so a plosive or a pause inside a sentence changes nothing. No
 * neural model is bundled: this is deterministic, allocation-free after construction, and runs in Node for the tests.
 * The same class runs inside an AudioWorklet: `vadWorkletSource` serialises it (Function.prototype.toString, the
 * class's own runtime name) into a processor module the page loads from a blob: URL, so the detector keeps up with
 * the audio thread at 128-frame blocks whatever the page's frame rate, and the page gets only transitions and a
 * level a few times a second. That is why VadCore is self-contained: it reaches nothing outside itself but Math.
 * What breaks if it is removed? The pill shows a level and nothing else: no speech state, no barge-in.
 */

/** The detector's tuning (VadCore takes a copy; the worklet gets it as processorOptions). */
export const VAD = Object.freeze({
  /** Samples per analysis frame: 512 is 10.7 ms at 48 kHz, 11.6 ms at 44.1 kHz (a power of two for the FFT). */
  frame: 512,
  /** An absolute RMS floor (about −56 dBFS): below it nothing is speech, whatever the noise floor says. */
  floor: 0.0015,
  /** RMS over the noise floor (as a ratio) that votes speech: 2.5 is about 8 dB. */
  energyRatio: 2.5,
  /** The zero-crossing rate above which a frame is hiss, not a voice (speech sits well under this). */
  zcrMax: 0.35,
  /** Decibels below a flat spectrum from which a frame is tonal enough to vote speech (white noise is near 0). */
  flatnessMin: 4,
  /** Frames in a row that read as speech before speech starts (4 is about 43 ms). */
  onsetFrames: 4,
  /** Frames in a row that read as the room before speech ends (24 is about 260 ms: a pause inside a sentence stays). */
  releaseFrames: 24,
  /** How much the noise floor rises per frame that is not speech (it drops at once): 0.4 % a frame, half a second to double.
   *  During speech it rises at a quarter of that, so a steady voiced noise (a fan's hum, traffic) that started speech
   *  becomes the room in a few seconds instead of reading as a voice for ever, while a person talking keeps it for many. */
  floorRise: 1.004,
  /** While the page itself is speaking (Sloane), the energy ratio is multiplied by this, so her own voice from the
   *  speakers is not taken for the visitor's (echo cancellation does most of it; this is the margin). */
  speakingMargin: 2,
  /** While she speaks and her voice comes back, speech starts only after onsetFrames times this (24 frames, about
   *  256 ms) ... */
  speakingOnset: 6,
  /** ... counted with a leak: a frame that is not speech takes this off the count instead of clearing it, so a visitor
   *  talking over her adds up syllable after syllable, while one loud syllable of hers stays one. */
  speakingLeak: 0.25,
  /** While she speaks but none of her voice comes back (headphones, or echo cancellation that takes it out), the onset
   *  is onsetFrames times this instead (6 frames): there is no echo of hers to mistake, and a quieter visitor still cuts in. */
  quietOnset: 1.5,
  /** Frames at the start of each of Sloane's lines (a line that cuts the one before included: VadCore.newLine) that
   *  only learn how loud her voice comes back through the speakers: no speech starts in them. The operating system's
   *  voice is not the browser's own audio, so the browser's echo cancellation may not take it out of the microphone at
   *  all. The learning covers the first echoWait frames (144 is about 1.5 s: an operating system's voice can start late
   *  after the page asks for it) and goes on for echoFrames (40, about 430 ms) after the last steady sound heard in
   *  them, so a voice that starts late is learned however a click or a cough came before it. A visitor who talks in
   *  that time is learned as her, and so is any sound that lasts (a cough, a click that rings on in the room). */
  echoFrames: 40,
  echoWait: 144,
  /** The steady level the learning takes is the quietest of the last this many frames, so a sound counts only once it
   *  touches all five: a knock or a click of up to three frames (32 ms) touches four at most, wherever it falls across
   *  them, and is never taken for her voice. */
  steadyFrames: 5,
  /** After that, a visitor talking over her must be this much louder than her loudest echo heard (1.6 is about 4 dB). */
  echoRatio: 1.6,
  /** Her loudest echo holds while her voice keeps coming back near it (within echoNear) and for this many frames after
   *  (140 is about 1.5 s, longer than the pause between her sentences), so a quiet stretch or a pause in her line never
   *  lowers the bar under her next stressed word ... */
  echoHold: 140,
  /** ... where near is within this ratio of it (1.41 is 3 dB). */
  echoNear: 1.41,
  /** Past the hold it falls by this per frame (about 1.5 s to halve): a wrong start (a visitor heard as her) wears off. */
  echoDecay: 0.995,
  /** It rises at most by this per frame (about 2.5 times a second): enough to follow her voice growing louder, too slow
   *  to climb with a visitor's own onset (tens of milliseconds) and so shut them out. */
  echoRise: 1.01,
  /** Decibels of smoothing on the reported level: the meter follows the voice, the decision does not use it. */
  levelSmooth: 0.6,
})

export type VadOptions = { [K in keyof typeof VAD]: number }

/** One analysis frame's features, for a test or a readout. */
export interface VadFeatures { rms: number; zcr: number; flatness: number }

/**
 * The detector. Feed it samples in any block size (`push`); it analyses every full frame, keeps `speech`, `rms`
 * (the smoothed level, 0..1) and `floor` (the noise floor it adapted to), and sets `changed` when a push crossed a
 * speech boundary. Self-contained on purpose (see the file comment): nothing outside it but Math.
 */
export class VadCore {
  readonly frame: number
  readonly floorMin: number
  readonly energyRatio: number
  readonly zcrMax: number
  readonly flatnessMin: number
  readonly onsetFrames: number
  readonly releaseFrames: number
  readonly floorRise: number
  readonly speakingMargin: number
  readonly speakingOnset: number
  readonly speakingLeak: number
  readonly quietOnset: number
  readonly echoFrames: number
  readonly echoWait: number
  readonly echoRatio: number
  readonly echoHold: number
  readonly echoNear: number
  readonly echoDecay: number
  readonly echoRise: number
  readonly levelSmooth: number
  /** The page is speaking (Sloane's voice is playing): the margin applies. */
  speaking = false
  /** Whether the microphone hears a person now. */
  speech = false
  /** The last push crossed a boundary (started or ended speech). */
  changed = false
  /** The smoothed level, 0..1 (RMS). */
  rms = 0
  /** The raw RMS of the last frame analysed. */
  frameRms = 0
  /** The noise floor the detector has adapted to (RMS). */
  floor: number
  /** Frames analysed since construction. */
  frames = 0
  /** Frames in a row that read as speech (while silent) or as the room (while speaking). */
  run = 0
  /** The loudest level of Sloane's voice heard back in the microphone during her current line (RMS; 0 when she is quiet). */
  echo = 0
  /** Frames since her current line started (0 when she is quiet). */
  speakFrames = 0
  /** The frame of her line the last steady sound came at within echoWait (−1 while none has). */
  heardAt = -1
  /** Frames since her voice last came back near her loudest echo. */
  echoQuiet = 0
  /** The RMS of the frames before this one, the newest first (the steady level is the quietest of them and this one). */
  readonly past: Float32Array
  /** The last frame's features. */
  zcr = 0
  flatness = 0
  readonly buf: Float32Array
  fill = 0
  readonly re: Float32Array
  readonly im: Float32Array

  constructor(o: Partial<VadOptions> = {}) {
    const n = Math.max(64, Math.round(Number(o.frame) || 512))
    // A power of two for the FFT: the nearest one at or above what was asked.
    this.frame = 1 << Math.ceil(Math.log2(n))
    this.past = new Float32Array(Math.max(0, Math.min(16, Math.round(Number(o.steadyFrames) || 5) - 1)))
    this.floorMin = Number(o.floor) > 0 ? Number(o.floor) : 0.0015
    this.energyRatio = Number(o.energyRatio) > 1 ? Number(o.energyRatio) : 2.5
    this.zcrMax = Number(o.zcrMax) > 0 ? Number(o.zcrMax) : 0.35
    this.flatnessMin = Number(o.flatnessMin) >= 0 ? Number(o.flatnessMin) : 4
    this.onsetFrames = Number(o.onsetFrames) >= 1 ? Math.round(Number(o.onsetFrames)) : 4
    this.releaseFrames = Number(o.releaseFrames) >= 1 ? Math.round(Number(o.releaseFrames)) : 24
    this.floorRise = Number(o.floorRise) > 1 ? Number(o.floorRise) : 1.004
    this.speakingMargin = Number(o.speakingMargin) >= 1 ? Number(o.speakingMargin) : 2
    this.speakingOnset = Number(o.speakingOnset) >= 1 ? Number(o.speakingOnset) : 6
    this.speakingLeak = Number(o.speakingLeak) >= 0 ? Number(o.speakingLeak) : 0.25
    this.quietOnset = Number(o.quietOnset) >= 1 ? Number(o.quietOnset) : 1.5
    this.echoFrames = Number(o.echoFrames) >= 0 ? Math.round(Number(o.echoFrames)) : 40
    this.echoWait = Number(o.echoWait) >= 0 ? Math.round(Number(o.echoWait)) : 144
    this.echoRatio = Number(o.echoRatio) >= 1 ? Number(o.echoRatio) : 1.6
    this.echoHold = Number(o.echoHold) >= 0 ? Math.round(Number(o.echoHold)) : 140
    this.echoNear = Number(o.echoNear) >= 1 ? Number(o.echoNear) : 1.41
    this.echoDecay = Number(o.echoDecay) > 0 && Number(o.echoDecay) <= 1 ? Number(o.echoDecay) : 0.995
    this.echoRise = Number(o.echoRise) >= 1 ? Number(o.echoRise) : 1.01
    this.levelSmooth = Number(o.levelSmooth) >= 0 && Number(o.levelSmooth) < 1 ? Number(o.levelSmooth) : 0.6
    this.floor = this.floorMin
    this.buf = new Float32Array(this.frame)
    this.re = new Float32Array(this.frame)
    this.im = new Float32Array(this.frame)
  }

  /** Feeds `length` samples of `x` from `offset`; returns how many frames were analysed. Never throws on odd input. */
  push(x: ArrayLike<number>, offset = 0, length = x.length - offset): number {
    this.changed = false
    let analysed = 0
    const buf = this.buf, n = this.frame
    let i = offset, end = offset + length
    if (!(end <= x.length)) end = x.length
    while (i < end) {
      const take = Math.min(n - this.fill, end - i)
      for (let k = 0; k < take; k++) {
        const v = x[i + k]
        buf[this.fill + k] = v === v && v < Infinity && v > -Infinity ? v : 0
      }
      this.fill += take
      i += take
      if (this.fill === n) {
        this.fill = 0
        this.step(buf)
        analysed++
      }
    }
    return analysed
  }

  /** Analyses one full frame and advances the state machine. */
  step(x: Float32Array): void {
    const n = this.frame
    let sum = 0, crossings = 0, prev = x[0]
    for (let k = 0; k < n; k++) {
      const v = x[k]
      sum += v * v
      if ((v >= 0) !== (prev >= 0)) crossings++
      prev = v
      this.re[k] = v
      this.im[k] = 0
    }
    const rms = Math.sqrt(sum / n)
    const zcr = crossings / (n - 1)
    VadCore.fft(this.re, this.im)
    // Spectral flatness over the bins above DC: the geometric mean over the arithmetic mean of the power, in dB below
    // flat (0 dB is white noise; a voice is many dB below).
    let logSum = 0, linSum = 0
    const half = n >> 1
    for (let k = 1; k < half; k++) {
      const p = this.re[k] * this.re[k] + this.im[k] * this.im[k] + 1e-20
      logSum += Math.log(p)
      linSum += p
    }
    const bins = half - 1
    const flatness = -10 * Math.log10(Math.exp(logSum / bins) / (linSum / bins))
    this.frameRms = rms
    this.zcr = zcr
    this.flatness = flatness
    this.frames++
    this.rms = this.rms * this.levelSmooth + rms * (1 - this.levelSmooth)
    // Sloane's line: its first echoWait frames, and echoFrames after the last steady sound in them, only learn how loud
    // her voice comes back (no onset in them); after that the visitor must be echoRatio louder than her loudest echo,
    // which holds while her voice keeps coming near it (a pause or a quiet stretch never lowers it under her next
    // stressed word), rises only slowly (a visitor's rising onset is never learned as hers) and falls only after a
    // long quiet.
    const past = this.past
    let steady = rms
    for (let k = 0; k < past.length; k++) if (past[k] < steady) steady = past[k]
    for (let k = past.length - 1; k > 0; k--) past[k] = past[k - 1]
    if (past.length > 0) past[0] = rms
    if (this.speaking) this.speakFrames++
    else this.newLine()
    if (this.speaking && this.speakFrames <= this.echoWait && steady > this.floor * this.energyRatio) this.heardAt = this.speakFrames
    const learning = this.speaking && (this.speakFrames <= this.echoWait || (this.heardAt >= 0 && this.speakFrames - this.heardAt < this.echoFrames))
    if (learning) this.echo = Math.max(this.echo, steady)
    // Her voice comes back: her loudest echo stands clear of the room.
    const echoed = this.echo > this.floor * this.energyRatio
    // The vote: louder than the room (mandatory), and not hiss, or harmonic.
    const ratio = this.speaking ? this.energyRatio * this.speakingMargin : this.energyRatio
    const loud = rms > this.floorMin && rms > this.floor * ratio && (!this.speaking || (!learning && rms > this.echo * this.echoRatio))
    const voiced = zcr < this.zcrMax || flatness > this.flatnessMin
    const isSpeech = loud && voiced
    if (this.speaking && !learning && !isSpeech) {
      if (rms > this.echo) this.echo = Math.min(rms, this.echo * this.echoRise)
      if (rms * this.echoNear >= this.echo) this.echoQuiet = 0
      else if (++this.echoQuiet > this.echoHold) this.echo = Math.max(this.echo * this.echoDecay, rms)
    }
    // The floor follows the room: down at once, up slowly, and a quarter as fast during speech (a voice that stays
    // would otherwise become the room at once; a steady voiced noise must become it in the end).
    const rise = isSpeech ? 1 + (this.floorRise - 1) / 4 : this.floorRise
    this.floor = rms < this.floor ? Math.max(this.floorMin, rms) : Math.min(this.floor * rise, Math.max(this.floorMin, rms))
    if (this.speech) {
      if (isSpeech) this.run = 0
      else if (++this.run >= this.releaseFrames) { this.speech = false; this.run = 0; this.changed = true }
    } else {
      const onset = !this.speaking ? this.onsetFrames : this.onsetFrames * (echoed ? this.speakingOnset : this.quietOnset)
      if (!isSpeech) this.run = this.speaking ? Math.max(0, this.run - this.speakingLeak) : 0
      else if (++this.run >= onset) { this.speech = true; this.run = 0; this.changed = true }
    }
  }

  /** The last frame's features. */
  features(): VadFeatures {
    return { rms: this.frameRms, zcr: this.zcr, flatness: this.flatness }
  }

  /**
   * Her next line starts (the page tells it when a new line cuts the one still playing, which is no edge of
   * `speaking`): its first echoWait frames learn her echo afresh, as at any line's start, so a voice that changed
   * (a provider's line cut by the operating system's, which echo cancellation may not take out) is learned, not cut.
   */
  newLine(): void {
    this.speakFrames = 0
    this.echo = 0
    this.heardAt = -1
    this.echoQuiet = 0
  }

  /** Forgets the state (the floor included): for a new stream. */
  reset(): void {
    this.speech = false
    this.changed = false
    this.rms = 0
    this.frameRms = 0
    this.floor = this.floorMin
    this.frames = 0
    this.run = 0
    this.fill = 0
    this.echo = 0
    this.speakFrames = 0
    this.heardAt = -1
    this.echoQuiet = 0
    this.past.fill(0)
  }

  /** In-place radix-2 FFT (the length is a power of two: the constructor made it one). */
  static fft(re: Float32Array, im: Float32Array): void {
    const n = re.length
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1
      for (; j & bit; bit >>= 1) j ^= bit
      j ^= bit
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len
      const wr = Math.cos(ang), wi = Math.sin(ang)
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0
        const half = len >> 1
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half
          const tr = re[b] * cr - im[b] * ci
          const ti = re[b] * ci + im[b] * cr
          re[b] = re[a] - tr; im[b] = im[a] - ti
          re[a] += tr; im[a] += ti
          const ncr = cr * wr - ci * wi
          ci = cr * wi + ci * wr
          cr = ncr
        }
      }
    }
  }
}

/** The processor's registered name. */
export const VAD_PROCESSOR = 'noir-vad'

/** What the worklet posts to the page: a level a few times a second, and every speech boundary. */
export interface VadMessage { rms: number; speech?: boolean; t: number }

/** What the page posts to the worklet. */
export interface VadCommand { speaking?: boolean; line?: boolean; reset?: boolean }

/**
 * The AudioWorklet processor module as source text: VadCore itself (by its runtime name, which a minifier may have
 * shortened) and a processor that feeds it the input's first channel, posts a level every `every` frames and every
 * boundary at once, and takes `speaking`, `line` (VadCore.newLine) and `reset` from the page. Load it from a blob: URL (the page's policy admits
 * blob: workers and scripts, index.html).
 */
export function vadWorkletSource(options: Partial<VadOptions> = VAD, every = 4): string {
  const core = VadCore.toString()
  const name = VadCore.name
  const n = Math.max(1, Math.round(every))
  return [
    core,
    `const VadOpts = ${JSON.stringify(options)};`,
    `class VadProcessor extends AudioWorkletProcessor {`,
    `  constructor(o) {`,
    `    super();`,
    `    this.core = new ${name}(Object.assign({}, VadOpts, (o && o.processorOptions) || {}));`,
    `    this.tick = 0;`,
    `    this.port.onmessage = (e) => { const d = e.data || {}; if (typeof d.speaking === 'boolean') this.core.speaking = d.speaking; if (d.line) this.core.newLine(); if (d.reset) this.core.reset(); };`,
    `  }`,
    `  process(inputs) {`,
    `    const ch = inputs[0] && inputs[0][0];`,
    `    if (!ch) return true;`,
    `    const frames = this.core.push(ch, 0, ch.length);`,
    `    if (this.core.changed) this.port.postMessage({ rms: this.core.rms, speech: this.core.speech, t: currentTime });`,
    `    else if (frames > 0 && (this.tick += frames) >= ${n}) { this.tick = 0; this.port.postMessage({ rms: this.core.rms, t: currentTime }); }`,
    `    return true;`,
    `  }`,
    `}`,
    `registerProcessor(${JSON.stringify(VAD_PROCESSOR)}, VadProcessor);`,
  ].join('\n')
}
