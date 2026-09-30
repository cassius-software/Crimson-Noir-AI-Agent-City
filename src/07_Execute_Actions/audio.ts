/**
 * Why does this file exist? It is the city's sound, fully procedural (no audio files): HRTF-panned engine
 * notes and tyre noise for the nearest cars, a crowd murmur from the nearest sidewalks, accessible-
 * pedestrian-signal tones at the nearest intersection while a walk phase runs, a short cue where someone
 * the operator asked over stands (08_Swarm/recruitment.ts), and speech from the operator's local speech server said
 * by a tethered person, placed at their head and following them as they walk (operator.ts gatedSay), muffled by any
 * building of the physics realm's own geometry that stands between them and the listener. The maths (gearbox, gain
 * curves, voice assignment, Doppler, synthesis) is exported as pure functions and unit-tested; the
 * Soundscape class only maps it onto a small, fixed Web Audio graph built once on the first user gesture.
 * What breaks if it is removed? The city is silent: approaching traffic gives no spatial cue and the walk
 * signal has no audible counterpart for players who cannot see it.
 */
import { CITY, type Box } from '../01_Initialize_World/city.ts'
import { createRng } from '../02_Define_The_Rules/degrees.ts'

export interface AudioFrame {
  dt: number
  listener: { x: number; y: number; z: number; yaw: number; pitch: number } // camera; forward = (-sin yaw·cos pitch, sin pitch, -cos yaw·cos pitch)
  cars: readonly { x: number; z: number; heading: number; speed: number; player: boolean }[] // forward = (sin h, 0, cos h)
  crowd: { near: number; waiting: number; crossing: number }   // agents drawn near the camera, waiting, crossing
  daylight: number                                              // 0 night … 1 day
  walk: { ew: boolean; ns: boolean }                            // walk signal active per axis
  intersection: { x: number; z: number }                        // nearest intersection centre to the listener
  interior: boolean                                             // listener is inside the car being driven
  speaker?: { x: number; z: number; walls?: number }            // where the person speaking stands (NaN: nobody), and the walls between (wallsBetween)
}

export type CarSample = AudioFrame['cars'][number]

export type AudioState = 'locked' | 'running' | 'suspended' | 'unsupported' | 'off'

/** Pooled car voices and the hysteresis that keeps them from hopping between cars. */
export const VOICE = {
  /** HRTF car voices. The driven car, if any, always holds one. */
  count: 5,
  /** Cars further than this are never voiced; a voiced car is released beyond maxDistance · release. */
  maxDistance: 70,
  release: 1.15,
  /** Loudness advantage (≈ +3.5 dB) a voiced car keeps over a challenger. */
  keep: 1.5,
  /** Seconds a voice stays on its car before another car can take it over. */
  minHold: 0.6,
  /** Fade time constant on release or hand-over, s; the switch happens after six of them (≈ −52 dB). */
  fade: 0.03,
  /** Inverse distance model shared by the car panners and the loudness estimate used for selection. */
  refDistance: 4,
  rolloff: 1.2,
  /** Engine bay ahead of the car's origin, m (where the voice sits). */
  nose: 1.2,
  height: 0.6,
} as const

/**
 * Four-stroke inline-four with a five-speed automatic that shifts early, as in light city driving. The
 * oscillator runs at half the crank rate so its wave can carry the half orders that give an engine its
 * uneven burble; the firing order (2nd crank order) is the wave's 4th harmonic.
 */
export const ENGINE = {
  idleRpm: 780,
  redlineRpm: 6200,
  upshiftRpm: 2500,
  downshiftRpm: 1300,
  /** Matches CAR.wheelRadius in vehicles.ts (not imported: that module pulls in Rapier). */
  wheelRadius: 0.34,
  finalDrive: 3.9,
  gears: [3.6, 2.1, 1.4, 1.0, 0.78],
  /** Oscillator hertz per rpm: half the crank rate. */
  fundamental: 1 / 120,
  harmonics: 64,
} as const

/** Crowd babble beds placed on the sidewalks around the listener. */
export const MURMUR = {
  sources: 4,
  /** Metres along the sidewalk either side of the listener. */
  spread: 7,
  height: 1.6,
  /** Near agents at which the murmur reaches 63 % of full level. */
  crowdScale: 60,
  level: 0.3,
  refDistance: 5,
  rolloff: 1,
  seconds: 8,
  talkers: 6,
} as const

/**
 * Accessible pedestrian signal tones, following the long-standing Canadian convention: a two-note
 * "cuckoo" for north–south crossings and a rising "chirp" for east–west ones. Notes are
 * [start s, length s, start Hz, end Hz]; each pattern loops every `period` seconds, and every note
 * fades in over `rise` and out over `fall` seconds. Deliberately quiet.
 */
export const APS = {
  level: 0.16,
  height: 1.4,
  refDistance: 3,
  rolloff: 1.4,
  ns: { period: 1.5, amplitude: 0.55, overtone: 0.22, rise: 0.008, fall: 0.04, notes: [[0, 0.2, 1100, 1100], [0.3, 0.26, 880, 880]] },
  ew: { period: 1.0, amplitude: 0.45, overtone: 0.08, rise: 0.004, fall: 0.025, notes: [[0, 0.09, 2000, 2800], [0.16, 0.09, 2000, 2800]] },
} as const

/** Inside the driven car: everything outside is muffled and quieter, the own engine comes through the firewall. */
export const CABIN = {
  cutoff: 750,
  open: 18000,
  outside: 0.55,
  ownEngine: 1.25,
  ownTyres: 0.6,
  /** Own engine sits this far ahead of the listener, m. */
  engineBay: 1.8,
} as const

/** Sample rate of the pre-rendered buffers (≥ 22.05 kHz for older WebKit; everything synthesized sits below 7 kHz). */
/**
 * The recruitment cue: a soft rising pair of notes placed where someone the operator asked over stands, so the
 * operator hears who is coming before they see them. One shot per request; a few may overlap.
 */
export const CUE = {
  /** Cues that can sound at once (each on its own panner). */
  slots: 2,
  /** [start s, length s, start Hz, end Hz]: D5 then G5, a gentle "over here". */
  notes: [[0, 0.16, 587.33, 587.33], [0.2, 0.3, 783.99, 783.99]] as readonly (readonly [number, number, number, number])[],
  rise: 0.012,
  fall: 0.12,
  amplitude: 0.32,
  overtone: 0.2,
  /** Head height, m, and the panners' inverse distance model. */
  height: 1.6,
  refDistance: 2,
  rolloff: 1,
} as const

/**
 * Speech (say): one voice at a time, at the speaker's head, following them. The audio comes whole from the operator's
 * local speech server (09_Cognition/localSpeech.ts); only its placement and level are decided here.
 */
export const SPEECH = {
  height: 1.6,
  /** Full level within this distance; tethered people stand about 1.5 m away. */
  refDistance: 1.5,
  rolloff: 1,
  /** Under the master make-up gain: a speech server's full-scale audio lands near the limiter's knee, not through it. */
  level: 0.5,
  /** Position glide as the speaker walks, s. */
  follow: 0.05,
  /** Fade when speech is cut (a stop, a broken tether), s: no click, and gone within a few tens of milliseconds. */
  fade: 0.015,
} as const

/**
 * Speech heard past buildings: each solid box of the city (the geometry the physics realm builds its colliders from)
 * that the line from the listener's head to the speaker's crosses closes a low-pass and lowers the level, as a voice
 * heard through or around a building sounds. Two or more walls sound the same.
 */
export const OCCLUSION = {
  /** Low-pass cutoff with nothing between, Hz: above hearing, no filtering. */
  open: 20000,
  one: { cutoff: 900, gain: 0.35 },
  more: { cutoff: 450, gain: 0.18 },
  /** Glide as the line opens or closes while the speaker walks, s. */
  glide: 0.08,
} as const

/**
 * How many boxes the straight line from `a` to `b` passes through (a slab test per box), counting up to `limit`. A box
 * below or above the line (a pier's deck, a seawall, a railing under head height) is not in the way.
 */
export function wallsBetween(boxes: readonly Box[], a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, limit = 2): number {
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minZ = Math.min(a.z, b.z), maxZ = Math.max(a.z, b.z)
  const d = [b.x - a.x, b.y - a.y, b.z - a.z]
  const p = [a.x, a.y, a.z]
  let n = 0
  for (const box of boxes) {
    if (box[3] < minX || box[0] > maxX || box[5] < minZ || box[2] > maxZ) continue
    let t0 = 0, t1 = 1
    for (let k = 0; k < 3 && t0 <= t1; k++) {
      const lo = box[k], hi = box[k + 3]
      if (Math.abs(d[k]) < 1e-9) {
        if (p[k] < lo || p[k] > hi) t1 = -1
        continue
      }
      const ta = (lo - p[k]) / d[k], tb = (hi - p[k]) / d[k]
      t0 = Math.max(t0, Math.min(ta, tb))
      t1 = Math.min(t1, Math.max(ta, tb))
    }
    if (t0 <= t1 && ++n >= limit) return n
  }
  return n
}

/** The speech voice's low-pass cutoff and level factor with `walls` in the way (none, one, or more). */
export function muffle(walls: number): { cutoff: number; gain: number } {
  if (!(walls >= 1)) return { cutoff: OCCLUSION.open, gain: 1 }
  return walls >= 2 ? { ...OCCLUSION.more } : { ...OCCLUSION.one }
}

export const SYNTH_RATE = 24000
const SPEED_OF_SOUND = 343
/** update() runs its control pass at most this often (60 Hz displays run it every frame). */
const CONTROL_INTERVAL = 1 / 75
/** Make-up gain after the volume taper; the limiter catches the rare pile-up. */
const MASTER_TRIM = 2
const MAX_VOICES = 16
/** Slightly different playback rates keep the beds (one shared babble loop) from phasing into each other. */
const BED_RATES = [0.97, 1, 1.025, 0.985] as const

/** NaN-safe: a bad input reads as 0, never reaches an AudioParam. */
const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0)

/** Web Audio's 'inverse' distance model, so the selection estimate and the panners agree. */
export function distanceGain(d: number, ref: number, rolloff: number): number {
  return ref / (ref + rolloff * (Math.max(d, ref) - ref))
}

/** Perceptual taper for the 0..1 volume control. */
export function volumeToGain(v: number): number {
  const c = clamp01(v)
  return c * c
}

function wheelRpm(speed: number): number {
  return (Math.abs(speed) / (2 * Math.PI * ENGINE.wheelRadius)) * 60
}

/** Gear index (0 = first) for `speed`, with separate up/down thresholds so a car cruising at a shift point holds its gear. */
export function selectGear(speed: number, gear: number, scale = 1): number {
  const top = ENGINE.gears.length - 1
  let g = Math.max(0, Math.min(top, Math.trunc(gear) || 0))
  const w = wheelRpm(speed) * ENGINE.finalDrive * scale
  while (g < top && w * ENGINE.gears[g] > ENGINE.upshiftRpm) g++
  while (g > 0 && w * ENGINE.gears[g] < ENGINE.downshiftRpm) g--
  return g
}

/** Engine rpm: wheel-driven rpm blended into idle (a torque converter slips at low speed), capped at the redline. */
export function engineRpm(speed: number, gear: number, scale = 1): number {
  const g = ENGINE.gears[Math.max(0, Math.min(ENGINE.gears.length - 1, Math.trunc(gear) || 0))]
  const w = wheelRpm(speed) * ENGINE.finalDrive * scale * g
  return Math.min(ENGINE.redlineRpm, Math.sqrt(ENGINE.idleRpm * ENGINE.idleRpm + w * w))
}

/** Engine load 0..1 from longitudinal acceleration (m/s²): coasting and braking are light, pulling away is heavy. */
export function engineLoad(accel: number): number {
  return clamp01(0.3 + accel * 0.35)
}

/** Engine note amplitude before distance. */
export function engineLevel(rpm: number, load: number): number {
  const rise = clamp01((rpm - ENGINE.idleRpm) / (3500 - ENGINE.idleRpm))
  return (0.16 + 0.34 * rise) * (0.5 + 0.5 * clamp01(load))
}

/** Low-pass cutoff on the engine note, Hz: brighter with revs and load. */
export function engineCutoff(rpm: number, load: number): number {
  return 160 + rpm * 0.22 + clamp01(load) * 700
}

/** Tyre and road noise amplitude: negligible at walking pace, dominant above ~50 km/h. */
export function tyreLevel(speed: number): number {
  return Math.min(1.5, Math.pow(Math.abs(speed) / 14, 1.7) * 0.55)
}

/** Centre of the tyre-noise band, Hz. */
export function tyreCutoff(speed: number): number {
  return Math.min(2600, 380 + 70 * Math.abs(speed))
}

/** A car's loudness before distance, for choosing which cars get a voice. */
export function carLoudness(speed: number): number {
  return engineLevel(engineRpm(speed, selectGear(speed, 0)), 0.45) + tyreLevel(speed)
}

/** Stable per-car pitch scale in [0.92, 1.08], so the fleet does not sound like one engine. */
export function carTimbre(index: number): number {
  let h = Math.imul((index | 0) + 1, 0x9e3779b1) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  return 0.92 + (h / 4294967296) * 0.16
}

/**
 * Frequency ratio heard for a source at (sx, sz) moving with (svx, svz), listener at (lx, lz) moving with
 * (lvx, lvz): (c − v_listener·u) / (c − v_source·u), u = unit vector source → listener. Clamped.
 */
export function dopplerFactor(sx: number, sz: number, svx: number, svz: number, lx: number, lz: number, lvx: number, lvz: number): number {
  const dx = lx - sx, dz = lz - sz
  const d = Math.sqrt(dx * dx + dz * dz)
  if (!(d > 1e-3)) return 1
  const ux = dx / d, uz = dz / d
  const f = (SPEED_OF_SOUND - (lvx * ux + lvz * uz)) / (SPEED_OF_SOUND - (svx * ux + svz * uz))
  return f > 1.25 ? 1.25 : f < 0.8 ? 0.8 : f
}

/** Listener forward (0..2) and up (3..5) vectors for the camera's yaw and pitch (three.js 'YXZ' order). */
export function listenerBasis(yaw: number, pitch: number, out: Float32Array | number[]): void {
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch)
  out[0] = -sy * cp; out[1] = sp; out[2] = -cy * cp
  out[3] = sy * sp; out[4] = cp; out[5] = cy * sp
}

/** Murmur level 0..1: saturating in the number of people near the camera, lower at night, busier while people cross. */
export function murmurLevel(near: number, waiting: number, crossing: number, daylight: number): number {
  const density = 1 - Math.exp(-Math.max(0, near || 0) / MURMUR.crowdScale)
  const busy = Math.max(0, crossing || 0) / Math.max(1, (waiting || 0) + (crossing || 0))
  return density * (0.3 + 0.7 * clamp01(daylight)) * (0.85 + 0.15 * clamp01(busy))
}

/**
 * Where the murmur beds sit: both sidewalks of the street the listener is on, `spread` metres ahead of and
 * behind them. Near an intersection that lands close to its four corners whichever street is chosen, so
 * the layout does not jump when the choice flips. Writes (x, z) pairs into out[0..7].
 */
export function murmurLayout(lx: number, lz: number, out: Float32Array | number[]): void {
  const p = CITY.pitch
  const sx = Math.round(lx / p) * p, sz = Math.round(lz / p) * p
  const alongX = Math.abs(lz - sz) <= Math.abs(lx - sx)
  let o = 0
  for (let side = -1; side <= 1; side += 2) {
    for (let a = -1; a <= 1; a += 2) {
      if (alongX) { out[o++] = lx + a * MURMUR.spread; out[o++] = sz + side * CITY.lane }
      else { out[o++] = sx + side * CITY.lane; out[o++] = lz + a * MURMUR.spread }
    }
  }
}

/** Slow swell (0.55..1) on murmur bed `i`: crowds ebb and flow over tens of seconds. */
export function murmurSwell(t: number, i: number): number {
  const w = 0.6 * Math.sin(2 * Math.PI * 0.07 * t + i * 1.9) + 0.4 * Math.sin(2 * Math.PI * 0.19 * t + i * 4.1)
  return 0.775 + 0.225 * w
}

const topCar = new Int32Array(MAX_VOICES)
const topScore = new Float64Array(MAX_VOICES)
const before = new Int32Array(MAX_VOICES)

/**
 * Chooses which cars the voice pool plays, in place: `slots[j]` is voice j's car index (−1 = idle) and
 * `age[j]` how long it has held it. The loudest cars at the listener win (the driven car always does);
 * a voiced car keeps a `VOICE.keep` advantage and cannot be displaced for `VOICE.minHold` seconds, and a car
 * that keeps its voice keeps the same slot. New cars take idle slots before just-released ones, which
 * still have to fade. Allocation-free (module scratch). Returns how many slots changed.
 */
export function assignVoices(cars: readonly CarSample[], lx: number, lz: number, dt: number, slots: Int32Array, age: Float32Array): number {
  const k = Math.min(slots.length, age.length, MAX_VOICES)
  const step = dt > 0 ? dt : 0
  let n = 0
  for (let j = 0; j < k; j++) before[j] = slots[j]
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]
    if (!Number.isFinite(c.x + c.z + c.speed + c.heading)) continue
    let held = -1
    for (let j = 0; j < k; j++) if (slots[j] === i) { held = j; break }
    let s: number
    if (c.player) s = Infinity
    else {
      const dx = c.x - lx, dz = c.z - lz
      const d = Math.sqrt(dx * dx + dz * dz)
      if (!(d <= (held >= 0 ? VOICE.maxDistance * VOICE.release : VOICE.maxDistance))) continue
      s = carLoudness(c.speed) * distanceGain(d, VOICE.refDistance, VOICE.rolloff)
      if (held >= 0) s = age[held] < VOICE.minHold ? 1e9 : s * VOICE.keep
    }
    if (n === k && !(s > topScore[k - 1])) continue
    let p = n < k ? n++ : k - 1
    while (p > 0 && s > topScore[p - 1]) { topScore[p] = topScore[p - 1]; topCar[p] = topCar[p - 1]; p-- }
    topScore[p] = s
    topCar[p] = i
  }
  let idle = 0
  for (let j = 0; j < k; j++) {
    const car = slots[j]
    if (car < 0) { idle |= 1 << j; continue }
    let kept = false
    for (let t = 0; t < n; t++) if (topCar[t] === car) { kept = true; break }
    if (!kept) slots[j] = -1
  }
  for (let t = 0; t < n; t++) {
    const car = topCar[t]
    let placed = false
    for (let j = 0; j < k; j++) if (slots[j] === car) { placed = true; break }
    if (placed) continue
    let free = -1
    for (let j = 0; j < k; j++) if (slots[j] < 0 && (idle & (1 << j)) !== 0) { free = j; break }
    if (free < 0) for (let j = 0; j < k; j++) if (slots[j] < 0) { free = j; break }
    if (free < 0) break
    slots[free] = car
  }
  let changes = 0
  for (let j = 0; j < k; j++) {
    if (slots[j] !== before[j]) { changes++; age[j] = 0 }
    else age[j] = slots[j] < 0 ? 0 : age[j] + step
  }
  return changes
}

/**
 * Engine wave coefficients (index = harmonic of the half-crank-rate fundamental). Firing orders dominate,
 * crank orders and half orders add the uneven texture; phases are spread so the wave's crest factor stays low.
 */
export function engineWave(n: number = ENGINE.harmonics): { real: Float32Array; imag: Float32Array } {
  const real = new Float32Array(n + 1), imag = new Float32Array(n + 1)
  const rng = createRng(0x0e4a1)
  for (let k = 1; k <= n; k++) {
    let a: number
    if (k % 4 === 0) a = 1 / Math.pow(k / 4, 0.7)
    else if (k % 2 === 0) a = 0.28 / Math.pow(k / 2, 0.8)
    else a = (0.12 / Math.pow(k, 0.6)) * (0.6 + 0.4 * rng())
    const phi = rng() * Math.PI * 2
    real[k] = a * Math.cos(phi)
    imag[k] = a * Math.sin(phi)
  }
  return { real, imag }
}

/** Uniform white noise in [−1, 1). */
export function renderNoise(out: Float32Array, seed: number): void {
  const rng = createRng(seed)
  for (let i = 0; i < out.length; i++) out[i] = rng() * 2 - 1
}

/**
 * Unintelligible crowd babble: `talkers` synthetic voices, each a glottal buzz plus breath through two
 * random formant resonators, gated into syllables (≈ 4 Hz) and words with pauses. Band-limited to the
 * speech band by the resonators; the loop seam is an equal-power crossfade, so `out` loops without a click.
 * Rendered in small steps (about `chunk` voiced samples each, ~1 ms) so the Soundscape can spread the work
 * over frames instead of stalling the gesture that unlocks audio; renderBabble() runs every step at once.
 */
export class BabbleRender {
  readonly out: Float32Array
  private readonly mix: Float32Array
  private readonly rng: () => number
  private readonly sampleRate: number
  private readonly work: Generator<void, void, void>
  private finished = false

  constructor(out: Float32Array, sampleRate: number, seed: number, talkers: number = MURMUR.talkers, chunk = Math.round(sampleRate / 4)) {
    this.out = out
    this.sampleRate = sampleRate
    this.rng = createRng(seed)
    // Rendered past the loop end by the seam length, which is folded back into the head at the end.
    this.mix = new Float32Array(out.length + Math.min(out.length >> 2, Math.round(sampleRate * 0.25)))
    this.work = this.run(talkers, Math.max(1, chunk))
  }

  get done(): boolean {
    return this.finished
  }

  /** Renders the next chunk (the last step folds the seam and normalises into `out`). True once finished. */
  step(): boolean {
    if (!this.finished && this.work.next().done) this.finished = true
    return this.finished
  }

  private *run(talkers: number, chunk: number): Generator<void, void, void> {
    const { mix, rng, sampleRate } = this
    const total = mix.length
    let budget = 0
    for (let k = 0; k < talkers; k++) {
      const f0 = rng() < 0.5 ? 95 + rng() * 45 : 175 + rng() * 60
      let phase = rng()
      let i = Math.floor(rng() * sampleRate * 0.4)
      while (i < total) {
        const syllables = 1 + Math.floor(rng() * 4)
        const wordPitch = f0 * (0.9 + rng() * 0.2)
        for (let s = 0; s < syllables && i < total; s++) {
          const len = Math.round(sampleRate * (0.11 + rng() * 0.2))
          const f1 = 300 + rng() * 500, f2 = 900 + rng() * 1400
          const voiced = 0.6 + rng() * 0.35
          const amp = 0.5 + rng() * 0.5
          phase = syllable(mix, i, Math.min(len, total - i), len, phase, wordPitch, f1, f2, voiced, amp, sampleRate, rng)
          i += len
          budget += len
          if (budget >= chunk) { budget = 0; yield }
        }
        i += Math.round(sampleRate * (0.08 + rng() * 0.45))
      }
    }
    yield
    this.finish()
  }

  private finish(): void {
    const { mix, out } = this
    const n = out.length, fade = mix.length - n
    for (let t = 0; t < n; t++) out[t] = mix[t]
    for (let t = 0; t < fade; t++) {
      const a = (t / fade) * Math.PI * 0.5
      out[t] = mix[t] * Math.sin(a) + mix[n + t] * Math.cos(a)
    }
    let sum = 0, peak = 0
    for (let t = 0; t < n; t++) { sum += out[t] * out[t]; peak = Math.max(peak, Math.abs(out[t])) }
    const rms = Math.sqrt(sum / Math.max(1, n))
    const gain = rms > 0 ? Math.min(0.2 / rms, 0.95 / peak) : 0
    for (let t = 0; t < n; t++) out[t] *= gain
  }
}

/** One-shot babble render (see BabbleRender). */
export function renderBabble(out: Float32Array, sampleRate: number, seed: number, talkers: number = MURMUR.talkers): void {
  const job = new BabbleRender(out, sampleRate, seed, talkers)
  while (!job.step()) { /* next chunk */ }
}

/**
 * Adds one syllable (`count` of its `len` samples, from `start`) to `mix`: buzz at `pitch` falling ~15 %
 * plus breath, through band-pass resonators at formants f1 and f2 (RBJ constant-peak, Q 6 and 8), under a
 * sin² envelope. The envelope follows the resonators and is zero at both edges, so starting each syllable
 * from fresh filter state cannot click. Returns the buzz phase to carry into the next syllable.
 */
function syllable(mix: Float32Array, start: number, count: number, len: number, phase: number, pitch: number, f1: number, f2: number, voiced: number, amp: number, sampleRate: number, rng: () => number): number {
  const w1 = (2 * Math.PI * f1) / sampleRate, al1 = Math.sin(w1) / 12, n1 = 1 + al1
  const w2 = (2 * Math.PI * f2) / sampleRate, al2 = Math.sin(w2) / 16, n2 = 1 + al2
  const a1 = (-2 * Math.cos(w1)) / n1, a2 = (1 - al1) / n1, b1 = al1 / n1
  const c1 = (-2 * Math.cos(w2)) / n2, c2 = (1 - al2) / n2, d1 = al2 / n2
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0
  for (let t = 0; t < count; t++) {
    const u = t / len
    phase += (pitch * (1.08 - 0.16 * u)) / sampleRate
    if (phase >= 1) phase -= 1
    const x = voiced * (2 * phase - 1) + (1 - voiced) * (rng() * 2 - 1)
    const y = b1 * (x - x2) - a1 * y1 - a2 * y2
    const z = d1 * (x - x2) - c1 * z1 - c2 * z2
    x2 = x1; x1 = x; y2 = y1; y1 = y; z2 = z1; z1 = z
    const env = Math.sin(Math.PI * u)
    mix[start + t] += amp * env * env * (0.7 * y + 0.45 * z)
  }
  return phase
}

/** Samples in one loop of the signal tone for `axis`. */
export function signalToneLength(axis: 'ew' | 'ns', sampleRate: number): number {
  return Math.round(APS[axis].period * sampleRate)
}

/**
 * One loop of the walk tone for `axis`: soft-edged notes (raised-cosine rise and fall), a quiet
 * overtone, silence between them, so the loop point is click-free.
 */
export function renderSignalTone(axis: 'ew' | 'ns', sampleRate: number, out: Float32Array): void {
  renderNotes(APS[axis], sampleRate, out)
}

/** Samples in the recruitment cue: its last note, and a little silence so it ends on nothing. */
export function cueLength(sampleRate: number): number {
  const end = Math.max(...CUE.notes.map(([start, length]) => start + length))
  return Math.round((end + 0.02) * sampleRate)
}

/** The recruitment cue, rendered like the walk tones (raised-cosine edges, a quiet overtone). */
export function renderCue(sampleRate: number, out: Float32Array): void {
  renderNotes(CUE, sampleRate, out)
}

interface NoteSpec {
  notes: readonly (readonly [number, number, number, number])[]
  rise: number
  fall: number
  amplitude: number
  overtone: number
}

function renderNotes(spec: NoteSpec, sampleRate: number, out: Float32Array): void {
  out.fill(0)
  for (const [start, length, f0, f1] of spec.notes) {
    const first = Math.round(start * sampleRate), count = Math.round(length * sampleRate)
    const rise = Math.max(1, Math.round(spec.rise * sampleRate)), fall = Math.max(1, Math.round(spec.fall * sampleRate))
    let phase = 0
    for (let t = 0; t < count && first + t < out.length; t++) {
      const u = t / count
      phase += (2 * Math.PI * (f0 + (f1 - f0) * u)) / sampleRate
      let env = 1
      if (t < rise) env = 0.5 - 0.5 * Math.cos((Math.PI * t) / rise)
      else if (t >= count - fall) env = 0.5 - 0.5 * Math.cos((Math.PI * (count - t)) / fall)
      out[first + t] += spec.amplitude * env * (Math.sin(phase) + spec.overtone * Math.sin(2 * phase)) / (1 + spec.overtone)
    }
  }
}

const noop = (): void => {}

/**
 * Web Audio takes single-precision floats (WebIDL `float`): NaN, ±Infinity and any double that rounds past
 * ±3.4e38 throw a TypeError, which inside update() would take the frame loop down. False for all of them.
 */
const representable = (v: number): boolean => v > -3.4e38 && v < 3.4e38

/**
 * k-rate where the browser supports it. Chrome and WebKit otherwise take the per-sample path while a glide
 * runs: panner azimuth and distance for all 128 samples of every quantum (on every panner as soon as the
 * listener moves, which is every frame) and biquad coefficients per sample. HRTF pans per quantum anyway,
 * and 2.7 ms steps under a 12–100 ms glide are inaudible. Gains stay a-rate so fades remain smooth.
 */
function kRate(p: AudioParam): AudioParam {
  if ('automationRate' in p) try { p.automationRate = 'k-rate' } catch { /* a fixed-rate param */ }
  return p
}

/** A dead-banded AudioParam: skips automation events that would not be heard, never schedules unrepresentable values. */
class Knob {
  readonly param: AudioParam
  private last = Number.NaN
  private readonly eps: number
  private readonly rel: number

  constructor(param: AudioParam, eps: number, rel = 0) {
    this.param = param
    this.eps = eps
    this.rel = rel
  }

  glide(v: number, now: number, tau: number): void {
    if (!representable(v) || Math.abs(v - this.last) <= this.eps + this.rel * Math.abs(v)) return
    this.last = v
    this.param.setTargetAtTime(v, now, tau)
  }

  jump(v: number, now: number): void {
    if (!representable(v)) return
    this.last = v
    this.param.cancelScheduledValues(now)
    this.param.setValueAtTime(v, now)
  }
}

/** An HRTF panner positioned through its AudioParams, or setPosition() where those are missing. */
class Spatial {
  readonly node: PannerNode
  readonly hrtf: boolean
  private readonly px: Knob | null
  private readonly py: Knob | null
  private readonly pz: Knob | null
  /** Last position sent; NaN until the first placement, which jumps instead of sweeping in from the origin. */
  private lx = Number.NaN
  private ly = Number.NaN
  private lz = Number.NaN

  constructor(ctx: AudioContext, ref: number, rolloff: number) {
    const p = ctx.createPanner()
    try { p.panningModel = 'HRTF' } catch { /* keeps equalpower */ }
    p.distanceModel = 'inverse'
    p.refDistance = ref
    p.rolloffFactor = rolloff
    p.maxDistance = 10000
    this.node = p
    this.hrtf = p.panningModel === 'HRTF'
    const params = typeof (p as Partial<PannerNode>).positionX === 'object'
    this.px = params ? new Knob(kRate(p.positionX), 0.01) : null
    this.py = params ? new Knob(kRate(p.positionY), 0.01) : null
    this.pz = params ? new Knob(kRate(p.positionZ), 0.01) : null
  }

  place(x: number, y: number, z: number, now: number, tau: number): void {
    if (Number.isNaN(this.lx)) { this.jump(x, y, z, now); return }
    if (this.px && this.py && this.pz) {
      this.px.glide(x, now, tau); this.py.glide(y, now, tau); this.pz.glide(z, now, tau)
      this.lx = x; this.ly = y; this.lz = z
    } else this.set(x, y, z)
  }

  private set(x: number, y: number, z: number): void {
    // `!(… <= ε)`: the NaN of the first call must count as a move.
    if (!representable(x) || !representable(y) || !representable(z)) return
    if (!(Math.abs(x - this.lx) + Math.abs(y - this.ly) + Math.abs(z - this.lz) <= 0.01)) {
      this.lx = x; this.ly = y; this.lz = z
      this.node.setPosition(x, y, z)
    }
  }

  jump(x: number, y: number, z: number, now: number): void {
    if (this.px && this.py && this.pz) {
      if (!representable(x) || !representable(y) || !representable(z)) return
      this.px.jump(x, now); this.py.jump(y, now); this.pz.jump(z, now)
      this.lx = x; this.ly = y; this.lz = z
    } else this.set(x, y, z)
  }
}

interface CarVoice {
  pan: Spatial
  freq: Knob
  engineCut: Knob
  engineGain: Knob
  tyreCut: Knob
  tyreGain: Knob
  sources: AudioScheduledSourceNode[]
  /** Car index currently sounding (−1 = idle); the pool's assignment is in Soundscape.slots. */
  car: number
  fading: boolean
  switchAt: number
  gear: number
  speed: number
  accel: number
  scale: number
}

interface Bed {
  pan: Spatial
  input: GainNode
  gain: Knob
  /** Started once the babble buffer has finished rendering. */
  source: AudioBufferSourceNode | null
}

interface Tone {
  buffer: AudioBuffer
  /** Shared level (APS.level, muffled in the cabin); only ever glides. */
  gain: GainNode
  level: Knob
  /** This walk phase's loop and its own envelope, so a stopping tail fades on its own gain. */
  source: AudioBufferSourceNode | null
  envelope: GainNode | null
  on: boolean
}

/** One recruitment cue voice: its panner and gain, the shot playing on it, and when that shot is over. */
interface Cue {
  pan: Spatial
  gain: GainNode
  source: AudioBufferSourceNode | null
  until: number
}

/** The speech voice: its panner, level and wall filter, and the utterance on it (its envelope, and how to tell it ended). */
interface Speech {
  pan: Spatial
  gain: GainNode
  level: Knob
  /** The low-pass the walls between close (OCCLUSION), between the level and the panner. */
  wall: BiquadFilterNode
  cut: Knob
  source: AudioBufferSourceNode | null
  envelope: GainNode | null
  /** Resolves the playing utterance's `ended`. */
  done: (() => void) | null
}

interface Graph {
  master: Knob
  cabin: Knob
  limiter: DynamicsCompressorNode
  voices: CarVoice[]
  beds: Bed[]
  babble: AudioBuffer
  /** Babble still rendering (one ~1 ms chunk per control pass); null once the beds play. */
  babbleJob: BabbleRender | null
  tones: { ew: Tone; ns: Tone }
  tonePan: Spatial
  cue: AudioBuffer
  cues: Cue[]
  speech: Speech
  listener: Knob[] | null
  hrtf: boolean
}

export class Soundscape {
  private ctx: AudioContext | null = null
  private graph: Graph | null = null
  private enabled = true
  private volume = 0.8
  private failed = false
  private disposed = false
  private pending = 0
  private suspendTimer: ReturnType<typeof setTimeout> | undefined
  private readonly supported: boolean
  private readonly slots = new Int32Array(VOICE.count).fill(-1)
  private readonly age = new Float32Array(VOICE.count)
  private readonly basis = new Float32Array(6)
  private readonly layout = new Float32Array(MURMUR.sources * 2)
  /** Last listener position (0..2) and forward/up basis (3..8) sent; NaN until the first control pass. */
  private readonly listenerAt = new Float32Array(9).fill(Number.NaN)
  private murmur = 0
  private readonly onVisibility = (): void => {
    const ctx = this.ctx
    if (!ctx || ctx.state === 'closed') return
    if (document.hidden) void ctx.suspend().catch(noop)
    else if (this.enabled) void ctx.resume().catch(noop)
  }

  constructor() {
    this.supported = typeof AudioContext === 'function' && typeof PannerNode === 'function'
  }

  /** Call from a user gesture (click, key, touchend). Idempotent: creates the context once, resumes it after that. */
  unlock(): void {
    if (!this.supported || this.failed || this.disposed) return
    if (!this.ctx) {
      try {
        const ctx = new AudioContext({ latencyHint: 'balanced' })
        this.ctx = ctx
        this.graph = this.build(ctx)
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility)
        // Disabled before the first gesture: keep the (possibly already running) context asleep.
        if (!this.enabled) void ctx.suspend().catch(noop)
      } catch {
        this.fail()
        return
      }
    }
    const hidden = typeof document !== 'undefined' && document.hidden
    if (this.enabled && !hidden && this.ctx.state !== 'running') void this.ctx.resume().catch(noop)
  }

  update(f: AudioFrame): void {
    const ctx = this.ctx, g = this.graph
    if (!ctx || !g || !this.enabled || ctx.state !== 'running') return
    this.pending += f.dt > 0 ? f.dt : 0
    if (this.pending < CONTROL_INTERVAL) return
    const dt = Math.min(this.pending, 0.1)
    this.pending = 0
    // Sound is never worth the frame: an audio stack that throws is switched off for good instead.
    try { this.control(f, ctx, g, dt) } catch { this.fail() }
  }

  /** One control pass: listener, car voices, murmur beds and walk tones. */
  private control(f: AudioFrame, ctx: AudioContext, g: Graph, dt: number): void {
    const L = f.listener
    if (!Number.isFinite(L.x + L.y + L.z + L.yaw + L.pitch)) return
    const now = ctx.currentTime
    if (g.babbleJob) this.renderBabbleStep(ctx, g, now)
    this.listen(g, ctx, L.x, L.y, L.z, L.yaw, L.pitch, now)

    const cars = f.cars
    let lvx = 0, lvz = 0, player = -1
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i]
      if (c.player && Number.isFinite(c.speed + c.heading)) { player = i; lvx = Math.sin(c.heading) * c.speed; lvz = Math.cos(c.heading) * c.speed; break }
    }
    const interior = f.interior && player >= 0
    g.cabin.glide(interior ? CABIN.cutoff : CABIN.open, now, 0.12)
    const outside = interior ? CABIN.outside : 1

    assignVoices(cars, L.x, L.z, dt, this.slots, this.age)
    for (let j = 0; j < g.voices.length; j++) {
      const v = g.voices[j]
      const next = this.slots[j]
      if (v.car !== next) {
        if (v.car < 0) this.attach(v, next, cars, now)
        else if (!v.fading) {
          v.fading = true
          v.switchAt = now + VOICE.fade * 6
          v.engineGain.glide(0, now, VOICE.fade)
          v.tyreGain.glide(0, now, VOICE.fade)
        } else if (now >= v.switchAt) this.attach(v, next, cars, now)
      } else if (v.fading) v.fading = false
      if (v.car < 0 || v.fading || v.car >= cars.length) continue

      const c = cars[v.car]
      const speed = Math.abs(c.speed)
      v.accel += ((speed - v.speed) / dt - v.accel) * Math.min(1, dt / 0.25)
      v.speed = speed
      v.gear = selectGear(speed, v.gear, v.scale)
      const rpm = engineRpm(speed, v.gear, v.scale)
      const load = engineLoad(v.accel)
      const fx = Math.sin(c.heading), fz = Math.cos(c.heading)
      const own = interior && v.car === player
      let x: number, y: number, z: number, doppler = 1
      if (own) { x = L.x + fx * CABIN.engineBay; y = L.y - 0.5; z = L.z + fz * CABIN.engineBay }
      else {
        x = c.x + fx * VOICE.nose; y = VOICE.height; z = c.z + fz * VOICE.nose
        doppler = dopplerFactor(x, z, fx * c.speed, fz * c.speed, L.x, L.z, lvx, lvz)
      }
      const wobble = 1 + 0.003 * Math.sin(now * 7.1 + j * 2.3) + 0.002 * Math.sin(now * 12.7 + j)
      v.pan.place(x, y, z, now, 0.03)
      v.freq.glide(rpm * ENGINE.fundamental * v.scale * doppler * wobble, now, 0.05)
      v.engineCut.glide(engineCutoff(rpm, load), now, 0.1)
      v.tyreCut.glide(tyreCutoff(speed) * doppler, now, 0.1)
      v.engineGain.glide(engineLevel(rpm, load) * (own ? CABIN.ownEngine : outside), now, 0.08)
      v.tyreGain.glide(tyreLevel(speed) * (own ? CABIN.ownTyres : outside), now, 0.08)
    }

    this.murmur = murmurLevel(f.crowd.near, f.crowd.waiting, f.crowd.crossing, f.daylight) * MURMUR.level * outside
    murmurLayout(L.x, L.z, this.layout)
    for (let i = 0; i < g.beds.length; i++) {
      const b = g.beds[i]
      b.pan.place(this.layout[i * 2], MURMUR.height, this.layout[i * 2 + 1], now, 0.3)
      b.gain.glide(this.murmur * murmurSwell(now, i), now, 0.4)
    }

    if (Number.isFinite(f.intersection.x + f.intersection.z)) g.tonePan.place(f.intersection.x, APS.height, f.intersection.z, now, 0.05)
    this.tone(ctx, g.tones.ew, f.walk.ew, outside, now)
    this.tone(ctx, g.tones.ns, f.walk.ns, outside, now)
    // The voice stays at the speaker's head as they walk (where they were last seen, if a reading is missing), muffled
    // by the walls between them and the listener.
    const sp = f.speaker
    if (g.speech.source && sp && Number.isFinite(sp.x + sp.z)) {
      g.speech.pan.place(sp.x, SPEECH.height, sp.z, now, SPEECH.follow)
      const m = muffle(sp.walls ?? 0)
      g.speech.cut.glide(m.cutoff, now, OCCLUSION.glide)
      g.speech.level.glide(SPEECH.level * m.gain, now, OCCLUSION.glide)
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    const ctx = this.ctx, g = this.graph
    if (!ctx || !g || ctx.state === 'closed') return
    const now = ctx.currentTime
    g.master.glide(on ? volumeToGain(this.volume) * MASTER_TRIM : 0, now, 0.05)
    clearTimeout(this.suspendTimer)
    this.suspendTimer = undefined
    if (on) {
      if (typeof document === 'undefined' || !document.hidden) void ctx.resume().catch(noop)
    } else {
      this.suspendTimer = setTimeout(() => {
        if (!this.enabled && ctx.state === 'running') void ctx.suspend().catch(noop)
      }, 300)
    }
  }

  setVolume(v: number): void {
    this.volume = clamp01(Number.isFinite(v) ? v : 0)
    const ctx = this.ctx, g = this.graph
    if (ctx && g && this.enabled) g.master.glide(volumeToGain(this.volume) * MASTER_TRIM, ctx.currentTime, 0.05)
  }

  /**
   * The recruitment cue where (x, z) is: someone the operator asked over. Sounds only while the soundscape does
   * (unlocked, on, running); a coordinate Web Audio cannot hold is refused. Returns whether it sounded.
   */
  cue(x: number, z: number): boolean {
    const ctx = this.ctx, g = this.graph
    if (!ctx || !g || !this.enabled || ctx.state !== 'running' || !representable(x) || !representable(z)) return false
    try {
      const now = ctx.currentTime
      // A free voice, or else the one closest to finishing (its shot is cut: the newest request matters more).
      let slot = g.cues[0]
      for (const c of g.cues) if (c.until < slot.until) slot = c
      if (slot.source) stopQuietly(slot.source)
      slot.pan.jump(x, CUE.height, z, now)
      const src = ctx.createBufferSource()
      src.buffer = g.cue
      src.connect(slot.gain)
      src.onended = () => {
        src.disconnect()
        if (slot.source === src) slot.source = null
      }
      src.start(now + 0.01)
      slot.source = src
      slot.until = now + 0.01 + g.cue.length / g.cue.sampleRate
      return true
    } catch {
      this.fail()
      return false
    }
  }

  /** Why speech cannot sound now, or null when it can (the soundscape unlocked, on and running). */
  private silence(): string | null {
    const st = this.status().state
    if (st === 'running') return null
    if (st === 'off') return "the city's sound is off: type audio on"
    if (st === 'unsupported') return "this browser cannot play the city's sound"
    if (st === 'locked') return "the city's sound starts with the first click or key press on the page"
    return "the city's sound is paused while the page is hidden"
  }

  /**
   * Decodes speech audio (a WAV from the local speech server; any format the browser reads) for speak(). Rejects when
   * the soundscape cannot sound or the bytes are not audio. The caller's bytes are left intact (a copy is decoded).
   */
  decodeSpeech(bytes: ArrayBuffer): Promise<AudioBuffer> {
    const why = this.silence()
    if (why !== null) return Promise.reject(new Error(why))
    const ctx = this.ctx!
    return ctx.decodeAudioData(bytes.slice(0)).catch(() => {
      throw new Error("the speech server's audio could not be decoded")
    })
  }

  /**
   * Says `buffer` at (x, z), head height, now, muffled by `walls` in the way (wallsBetween): the voice then follows
   * AudioFrame.speaker each control pass. One utterance at a time: a new one cuts the one playing (it fades out, and
   * its `ended` resolves). `stop` fades it out within a few tens of milliseconds; `ended` resolves when it has played
   * out or been stopped, and never rejects. Throws when the soundscape cannot sound, or when (x, z) is not a position
   * Web Audio can hold.
   */
  speak(buffer: AudioBuffer, x: number, z: number, walls = 0): { readonly ended: Promise<void>; stop(): void } {
    const why = this.silence()
    if (why !== null) throw new Error(why)
    if (!representable(x) || !representable(z)) throw new Error('the speaker has no position to speak from')
    const ctx = this.ctx!, g = this.graph!
    const sp = g.speech
    const now = ctx.currentTime
    this.hush(sp, now)
    sp.pan.jump(x, SPEECH.height, z, now)
    const m = muffle(walls)
    sp.cut.jump(m.cutoff, now)
    sp.level.jump(SPEECH.level * m.gain, now)
    const envelope = ctx.createGain()
    envelope.connect(sp.gain)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(envelope)
    let finish: () => void = noop
    const ended = new Promise<void>((resolve) => { finish = resolve })
    const end = (): void => {
      finish()
      if (sp.source === src) { sp.source = null; sp.envelope = null; sp.done = null }
    }
    src.onended = () => {
      src.disconnect()
      envelope.disconnect()
      end()
    }
    src.start(now + 0.01)
    sp.source = src
    sp.envelope = envelope
    sp.done = end
    return Object.freeze({
      ended,
      stop: () => {
        const c = this.ctx, gg = this.graph
        if (c && gg && gg.speech.source === src) this.hush(gg.speech, c.currentTime)
      },
    })
  }

  /** Whether an utterance is playing. */
  get speaking(): boolean {
    return this.graph?.speech.source != null
  }

  /** Fades the utterance on `sp` out and ends it now (its source stops once the fade is inaudible). */
  private hush(sp: Speech, now: number): void {
    const src = sp.source, envelope = sp.envelope, done = sp.done
    sp.source = null
    sp.envelope = null
    sp.done = null
    if (!src || !envelope) return
    envelope.gain.setTargetAtTime(0, now, SPEECH.fade)
    stopQuietly(src, now + SPEECH.fade * 6)
    done?.()
  }

  /** `voices` counts sources currently audible: car voices, murmur beds, walk tones, recruitment cues and speech. */
  status(): { state: AudioState; voices: number; hrtf: boolean; volume: number } {
    const g = this.graph
    let state: AudioState
    if (!this.supported || this.failed) state = 'unsupported'
    else if (!this.enabled || this.disposed) state = 'off'
    else if (!this.ctx) state = 'locked'
    else state = this.ctx.state === 'running' ? 'running' : 'suspended'
    let voices = 0
    if (g && state === 'running') {
      for (const v of g.voices) if (v.car >= 0 && !v.fading) voices++
      if (this.murmur > 1e-3 && !g.babbleJob) voices += g.beds.length
      if (g.tones.ew.on) voices++
      if (g.tones.ns.on) voices++
      const now = this.ctx!.currentTime
      for (const c of g.cues) if (c.source && c.until > now) voices++
      if (g.speech.source) voices++
    }
    return { state, voices, hrtf: g?.hrtf ?? false, volume: this.volume }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.teardown()
  }

  /** The audio stack threw (at creation or mid-frame): release it and report 'unsupported' from now on. */
  private fail(): void {
    this.failed = true
    this.teardown()
  }

  /** Stops every source, closes the context and drops the listener and timer; closing frees the whole graph. */
  private teardown(): void {
    clearTimeout(this.suspendTimer)
    this.suspendTimer = undefined
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility)
    const g = this.graph, ctx = this.ctx
    this.graph = null
    this.ctx = null
    if (g) {
      g.babbleJob = null
      for (const v of g.voices) for (const s of v.sources) stopQuietly(s)
      for (const b of g.beds) if (b.source) stopQuietly(b.source)
      if (g.tones.ew.source) stopQuietly(g.tones.ew.source)
      if (g.tones.ns.source) stopQuietly(g.tones.ns.source)
      for (const c of g.cues) if (c.source) stopQuietly(c.source)
      // The context is closing: its sources may never report their end, so the utterance ends here.
      const sp = g.speech
      if (sp.source) stopQuietly(sp.source)
      sp.done?.()
      sp.source = null; sp.envelope = null; sp.done = null
    }
    if (ctx && ctx.state !== 'closed') {
      try { void ctx.close().catch(noop) } catch { /* already closing */ }
    }
  }

  private build(ctx: AudioContext): Graph {
    const now = ctx.currentTime
    // A gentle safety limiter; its time constants stay at the defaults (3 ms in, 250 ms out).
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -10
    limiter.knee.value = 6
    limiter.ratio.value = 8
    limiter.connect(ctx.destination)
    const master = ctx.createGain()
    master.gain.value = this.enabled ? volumeToGain(this.volume) * MASTER_TRIM : 0
    master.connect(limiter)
    const cabin = ctx.createBiquadFilter()
    cabin.type = 'lowpass'
    cabin.frequency.value = CABIN.open
    cabin.Q.value = 0.707
    cabin.connect(master)
    const bus: AudioNode = cabin

    const noise = ctx.createBuffer(1, SYNTH_RATE * 2, SYNTH_RATE)
    renderNoise(noise.getChannelData(0), 0x5eed)
    const wave = engineWave()
    const periodic = ctx.createPeriodicWave(wave.real, wave.imag)
    let hrtf = true
    const voices: CarVoice[] = []
    for (let j = 0; j < VOICE.count; j++) {
      const pan = new Spatial(ctx, VOICE.refDistance, VOICE.rolloff)
      hrtf &&= pan.hrtf
      pan.node.connect(bus)
      const osc = ctx.createOscillator()
      osc.setPeriodicWave(periodic)
      osc.frequency.value = ENGINE.idleRpm * ENGINE.fundamental
      const engineFilter = ctx.createBiquadFilter()
      engineFilter.type = 'lowpass'
      engineFilter.Q.value = 0.9
      const engineGain = ctx.createGain()
      engineGain.gain.value = 0
      osc.connect(engineFilter)
      engineFilter.connect(engineGain)
      engineGain.connect(pan.node)
      const hiss = ctx.createBufferSource()
      hiss.buffer = noise
      hiss.loop = true
      const tyreFilter = ctx.createBiquadFilter()
      tyreFilter.type = 'bandpass'
      tyreFilter.Q.value = 0.6
      const tyreGain = ctx.createGain()
      tyreGain.gain.value = 0
      hiss.connect(tyreFilter)
      tyreFilter.connect(tyreGain)
      tyreGain.connect(pan.node)
      osc.start(now)
      hiss.start(now, (j * 0.37) % 2)
      voices.push({
        pan,
        freq: new Knob(kRate(osc.frequency), 0, 0.001),
        engineCut: new Knob(kRate(engineFilter.frequency), 0, 0.01),
        engineGain: new Knob(engineGain.gain, 0.002),
        tyreCut: new Knob(kRate(tyreFilter.frequency), 0, 0.01),
        tyreGain: new Knob(tyreGain.gain, 0.002),
        sources: [osc, hiss],
        car: -1, fading: false, switchAt: 0, gear: 0, speed: 0, accel: 0, scale: 1,
      })
    }

    const babble = ctx.createBuffer(1, SYNTH_RATE * MURMUR.seconds, SYNTH_RATE)
    const babbleJob = new BabbleRender(babble.getChannelData(0), SYNTH_RATE, 0xb4bb1e)
    const beds: Bed[] = []
    for (let i = 0; i < MURMUR.sources; i++) {
      const pan = new Spatial(ctx, MURMUR.refDistance, MURMUR.rolloff)
      hrtf &&= pan.hrtf
      pan.node.connect(bus)
      const input = ctx.createGain()
      input.gain.value = 0
      input.connect(pan.node)
      beds.push({ pan, input, gain: new Knob(input.gain, 0.002), source: null })
    }

    const tonePan = new Spatial(ctx, APS.refDistance, APS.rolloff)
    hrtf &&= tonePan.hrtf
    tonePan.node.connect(bus)
    const tone = (axis: 'ew' | 'ns'): Tone => {
      const buffer = ctx.createBuffer(1, signalToneLength(axis, SYNTH_RATE), SYNTH_RATE)
      renderSignalTone(axis, SYNTH_RATE, buffer.getChannelData(0))
      const gain = ctx.createGain()
      gain.gain.value = APS.level
      gain.connect(tonePan.node)
      return { buffer, gain, level: new Knob(gain.gain, 0.002), source: null, envelope: null, on: false }
    }

    const cue = ctx.createBuffer(1, cueLength(SYNTH_RATE), SYNTH_RATE)
    renderCue(SYNTH_RATE, cue.getChannelData(0))
    const cues: Cue[] = []
    for (let i = 0; i < CUE.slots; i++) {
      const pan = new Spatial(ctx, CUE.refDistance, CUE.rolloff)
      hrtf &&= pan.hrtf
      pan.node.connect(bus)
      const gain = ctx.createGain()
      gain.connect(pan.node)
      cues.push({ pan, gain, source: null, until: -Infinity })
    }

    const speechPan = new Spatial(ctx, SPEECH.refDistance, SPEECH.rolloff)
    hrtf &&= speechPan.hrtf
    speechPan.node.connect(bus)
    const speechWall = ctx.createBiquadFilter()
    speechWall.type = 'lowpass'
    speechWall.Q.value = 0.7
    speechWall.frequency.value = OCCLUSION.open
    speechWall.connect(speechPan.node)
    const speechGain = ctx.createGain()
    speechGain.gain.value = SPEECH.level
    speechGain.connect(speechWall)
    const speech: Speech = {
      pan: speechPan, gain: speechGain, level: new Knob(speechGain.gain, 0.001), wall: speechWall, cut: new Knob(kRate(speechWall.frequency), 1),
      source: null, envelope: null, done: null,
    }

    const l = ctx.listener
    const params = typeof (l as Partial<AudioListener>).positionX === 'object'
    const listener = params
      ? [l.positionX, l.positionY, l.positionZ, l.forwardX, l.forwardY, l.forwardZ, l.upX, l.upY, l.upZ].map((p, i) => new Knob(kRate(p), i < 3 ? 0.01 : 0.001))
      : null
    return {
      master: new Knob(master.gain, 0.0005), cabin: new Knob(kRate(cabin.frequency), 0, 0.01), limiter, voices, beds, babble, babbleJob,
      tones: { ew: tone('ew'), ns: tone('ns') }, tonePan, cue, cues, speech, listener, hrtf,
    }
  }

  /** One babble chunk per control pass; when the buffer is complete, the beds start looping it. */
  private renderBabbleStep(ctx: AudioContext, g: Graph, now: number): void {
    if (!g.babbleJob || !g.babbleJob.step()) return
    g.babbleJob = null
    for (let i = 0; i < g.beds.length; i++) {
      const b = g.beds[i]
      const s = ctx.createBufferSource()
      s.buffer = g.babble
      s.loop = true
      s.playbackRate.value = BED_RATES[i % BED_RATES.length]
      s.connect(b.input)
      // The loops open mid-waveform and the bed gains have been following the crowd while silent: start
      // from zero so this pass's glide swells them in instead of switching them on with a click.
      b.gain.jump(0, now)
      s.start(now, (i * MURMUR.seconds) / MURMUR.sources + 0.31 * i)
      b.source = s
    }
  }

  private listen(g: Graph, ctx: AudioContext, x: number, y: number, z: number, yaw: number, pitch: number, now: number): void {
    const b = this.basis
    listenerBasis(yaw, pitch, b)
    const at = this.listenerAt
    const k = g.listener
    if (k) {
      if (Number.isNaN(at[0])) { k[0].jump(x, now); k[1].jump(y, now); k[2].jump(z, now) }
      else { k[0].glide(x, now, 0.03); k[1].glide(y, now, 0.03); k[2].glide(z, now, 0.03) }
      // A glide between orientations 90° or more apart sweeps the forward vector through (or near) zero
      // length, where the panners' azimuth is undefined: camera cuts (entering a car) jump instead.
      const cut = !(b[0] * at[3] + b[1] * at[4] + b[2] * at[5] > 0)
      for (let i = 0; i < 6; i++) {
        if (cut) k[3 + i].jump(b[i], now)
        else k[3 + i].glide(b[i], now, 0.012)
        at[3 + i] = b[i]
      }
      at[0] = x; at[1] = y; at[2] = z
      return
    }
    const l = ctx.listener
    if (!(Math.abs(x - at[0]) + Math.abs(y - at[1]) + Math.abs(z - at[2]) <= 0.01) && representable(x) && representable(y) && representable(z)) {
      at[0] = x; at[1] = y; at[2] = z
      l.setPosition(x, y, z)
    }
    let turn = 0
    for (let i = 0; i < 6; i++) turn += Math.abs(b[i] - at[3 + i])
    if (!(turn <= 0.002)) {
      for (let i = 0; i < 6; i++) at[3 + i] = b[i]
      l.setOrientation(b[0], b[1], b[2], b[3], b[4], b[5])
    }
  }

  /** Voice `v` takes car `next` (−1 = none) while silent: parameters jump to the new car, then the gains fade in. */
  private attach(v: CarVoice, next: number, cars: readonly CarSample[], now: number): void {
    v.car = next
    v.fading = false
    v.engineGain.jump(0, now)
    v.tyreGain.jump(0, now)
    if (next < 0 || next >= cars.length) { v.car = -1; return }
    const c = cars[next]
    const speed = Math.abs(c.speed)
    v.scale = carTimbre(next)
    v.speed = speed
    v.accel = 0
    v.gear = selectGear(speed, 0, v.scale)
    const rpm = engineRpm(speed, v.gear, v.scale)
    v.pan.jump(c.x + Math.sin(c.heading) * VOICE.nose, VOICE.height, c.z + Math.cos(c.heading) * VOICE.nose, now)
    v.freq.jump(rpm * ENGINE.fundamental * v.scale, now)
    v.engineCut.jump(engineCutoff(rpm, 0.3), now)
    v.tyreCut.jump(tyreCutoff(speed), now)
  }

  /**
   * Walk tone for one axis: a fresh looping source per walk phase, so the pattern starts on its first note
   * (the loop opens on silence). Each phase fades out on its own envelope, so a phase that starts while the
   * previous one's tail is still fading (a clock jump) neither revives that tail nor cuts it off.
   */
  private tone(ctx: AudioContext, t: Tone, want: boolean, outside: number, now: number): void {
    t.level.glide(APS.level * outside, now, 0.03)
    if (want && !t.on) {
      const envelope = ctx.createGain()
      envelope.connect(t.gain)
      const s = ctx.createBufferSource()
      s.buffer = t.buffer
      s.loop = true
      s.connect(envelope)
      s.start(now + 0.02)
      t.source = s
      t.envelope = envelope
      t.on = true
    } else if (!want && t.on) {
      t.on = false
      const s = t.source, envelope = t.envelope
      t.source = null
      t.envelope = null
      if (s && envelope) {
        envelope.gain.setTargetAtTime(0, now, 0.08)
        s.onended = () => { s.disconnect(); envelope.disconnect() }
        stopQuietly(s, now + 0.6)
      }
    }
  }
}

function stopQuietly(s: AudioScheduledSourceNode, when?: number): void {
  try { s.stop(when) } catch { /* already stopped */ }
}
