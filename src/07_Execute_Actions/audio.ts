/**
 * Why does this file exist? It is the city's sound, fully procedural (no audio files): HRTF-panned engine
 * notes and tyre noise for the nearest cars, a crowd murmur from the nearest sidewalks, accessible-
 * pedestrian-signal tones at the nearest intersection while a walk phase runs, a short cue where someone
 * the operator asked over stands (08_Swarm/recruitment.ts), and speech from the operator's local speech server said
 * by a tethered person, placed at their head and following them as they walk (operator.ts gatedSay), muffled by any
 * building of the physics realm's own geometry that stands between them and the listener, and placed in the room it
 * is said from (acoustics.ts: the street canyon's reverberation through one convolver with per-group sends, the
 * through-the-wall coupling of a voice in another street). A peer's voice (a MediaStream the host hands in; no
 * connection is opened here) is placed in the same space. Every sound's start, change and stop is reported to one
 * listener (`onSound`, a plain event with the sound's world point) so the HUD can caption it (captions.ts). The maths
 * (gearbox, gain curves, voice assignment, Doppler, synthesis) is exported as pure functions and unit-tested; the
 * Soundscape class only maps it onto a small, fixed Web Audio graph built once on the first user gesture.
 * What breaks if it is removed? The city is silent: approaching traffic gives no spatial cue and the walk
 * signal has no audible counterpart for players who cannot see it.
 */
import { CITY, type Box } from '../01_Initialize_World/city.ts'
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import { eavesdrop, impulseLength, renderImpulse, roomKey, sabineRt60, transmissionLoss, type Room } from './acoustics.ts'
import { CAPTIONS, type CaptionEvent, type SoundKind, type SoundPhase } from './captions.ts'

export interface AudioFrame {
  dt: number
  listener: { x: number; y: number; z: number; yaw: number; pitch: number } // camera; forward = (-sin yaw·cos pitch, sin pitch, -cos yaw·cos pitch)
  cars: readonly { x: number; z: number; heading: number; speed: number; player: boolean }[] // forward = (sin h, 0, cos h)
  crowd: { near: number; waiting: number; crossing: number }   // agents drawn near the camera, waiting, crossing
  daylight: number                                              // 0 night … 1 day
  walk: { ew: boolean; ns: boolean }                            // walk signal active per axis
  intersection: { x: number; z: number }                        // nearest intersection centre to the listener
  interior: boolean                                             // listener is inside the car being driven
  /** The room the listener stands in (acoustics.ts roomAt); absent: dry, no reverberation. */
  room?: Room
  /** Where the person speaking stands (NaN: nobody), the walls between (wallsBetween), and their room. */
  speaker?: { x: number; z: number; walls?: number; room?: Room }
  /** Where each attached peer voice (attachPeer) stands, the walls between, and their room; unknown ids are ignored. */
  peers?: readonly { id: number; x: number; z: number; walls?: number; room?: Room }[]
}

/** A peer's voice in the space (attachPeer): where its player stands, and how to let it go. */
export interface PeerVoice {
  /** Puts (or moves) the voice at (x, z), head height, muffled by `walls` and placed in `room`. */
  place(x: number, z: number, walls?: number, room?: Room): void
  /** Fades the voice out and releases its nodes; idempotent. */
  detach(): void
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
 * The ping's cue (08_Swarm/ping.ts): two short notes a fifth higher than the recruitment cue (C6 then G6), so the ear
 * tells a mark the operator set from someone coming over. Sounds on the recruitment cue's panners.
 */
export const PING = {
  /** [start s, length s, start Hz, end Hz]. */
  notes: [[0, 0.1, 1046.5, 1046.5], [0.14, 0.18, 1567.98, 1567.98]] as readonly (readonly [number, number, number, number])[],
  rise: 0.008,
  fall: 0.08,
  amplitude: 0.26,
  overtone: 0.12,
} as const

/**
 * The room's reverberation (acoustics.ts): one convolver fed by a send per sound group, its impulse swapped when the
 * listener's room bucket changes, the sends held at nothing while the swap waits so it cannot click.
 */
export const REVERB = {
  /** Seconds the sends are held silent before a new impulse is set. */
  swap: 0.15,
  /** Glide of a send towards its wetness, s. */
  glide: 0.1,
  /** Impulses kept rendered, by room key; the cache is emptied when it is full. */
  cache: 32,
  /** Seed of every rendered impulse (same room, same tail). */
  seed: 0x1337,
} as const

/** Seconds between the repeated `start` events that keep a long sound's caption alive (captions.ts CAPTIONS.ttl). */
export const CAPTION_REFRESH = 3

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

/**
 * The speech voice's low-pass cutoff and level factor with `walls` in the way (none, one, or more): the masonry table
 * of acoustics.ts, which is OCCLUSION number for number.
 */
export function muffle(walls: number): { cutoff: number; gain: number } {
  return transmissionLoss(walls, 'masonry')
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

/** Samples in the ping's cue: its last note, and a little silence so it ends on nothing. */
export function pingLength(sampleRate: number): number {
  const end = Math.max(...PING.notes.map(([start, length]) => start + length))
  return Math.round((end + 0.02) * sampleRate)
}

/** The ping's cue, rendered like the recruitment cue. */
export function renderPing(sampleRate: number, out: Float32Array): void {
  renderNotes(PING, sampleRate, out)
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
  /** Its reverb send (null without a convolver). */
  send: Knob | null
  /** Where the voice last sounded, for its captions. */
  x: number
  z: number
  /** The caption's motion word ('approaching', 'passing', 'idle'; '' before the first; 'own' for the driven car, uncaptioned). */
  word: string
  /** The tyres are captioned (their noise is louder than the engine's). */
  tyres: boolean
  /** When the engine caption was last started or refreshed. */
  captionAt: number
}

interface Bed {
  pan: Spatial
  input: GainNode
  gain: Knob
  /** Started once the babble buffer has finished rendering. */
  source: AudioBufferSourceNode | null
}

interface Tone {
  axis: 'ew' | 'ns'
  buffer: AudioBuffer
  /** Shared level (APS.level, muffled in the cabin); only ever glides. */
  gain: GainNode
  level: Knob
  /** This walk phase's loop and its own envelope, so a stopping tail fades on its own gain. */
  source: AudioBufferSourceNode | null
  envelope: GainNode | null
  on: boolean
  captionAt: number
}

/** One cue voice: its panner and gain, the shot playing on it (a recruitment cue or a ping), where, and when it is over. */
interface Cue {
  pan: Spatial
  gain: GainNode
  source: AudioBufferSourceNode | null
  until: number
  kind: 'cue' | 'ping'
  x: number
  z: number
}

/** The speech voice: its panner, level and wall filter, and the utterance on it (its envelope, and how to tell it ended). */
interface Speech {
  pan: Spatial
  gain: GainNode
  level: Knob
  /** The low-pass the walls between close (OCCLUSION), between the level and the panner. */
  wall: BiquadFilterNode
  cut: Knob
  send: Knob | null
  source: AudioBufferSourceNode | null
  envelope: GainNode | null
  /** Resolves the playing utterance's `ended`. */
  done: (() => void) | null
  /** The utterance's caption: who, their words, where it was last heard, whether a wall muffles it. */
  agent: number
  label: string | undefined
  text: string | undefined
  x: number
  z: number
  muffled: boolean
  captionAt: number
}

/** A peer's voice: the host's MediaStream through a level, a wall filter and its own HRTF panner (attachPeer). */
interface Peer {
  id: number
  label: string | undefined
  source: MediaStreamAudioSourceNode
  gain: GainNode
  level: Knob
  wall: BiquadFilterNode
  cut: Knob
  pan: Spatial
  send: Knob | null
  /** Placed and audible (the level is up): counted as a voice. */
  live: boolean
  /** Detached: when its nodes may be disconnected (the fade is done); Infinity while attached. */
  detachAt: number
  x: number
  z: number
  muffled: boolean
  captionAt: number
}

/** The room's reverberation: the convolver, the impulse it holds (by room key) and the one waiting to replace it. */
interface Reverb {
  convolver: ConvolverNode
  /** The room key of the impulse set; '' until the first room. */
  key: string
  pendingKey: string | null
  swapAt: number
  cache: Map<string, AudioBuffer>
  /** The group sends (the car voices, the speech voice and the peers carry their own). */
  beds: Knob
  tones: Knob
  cues: Knob
}

interface Graph {
  master: Knob
  cabin: Knob
  /** The shared bus every panner joins (the cabin low-pass); peers attach to it later. */
  bus: AudioNode
  limiter: DynamicsCompressorNode
  voices: CarVoice[]
  beds: Bed[]
  babble: AudioBuffer
  /** Babble still rendering (one ~1 ms chunk per control pass); null once the beds play. */
  babbleJob: BabbleRender | null
  tones: { ew: Tone; ns: Tone }
  tonePan: Spatial
  cue: AudioBuffer
  ping: AudioBuffer
  cues: Cue[]
  speech: Speech
  /** Null where the browser has no ConvolverNode: every voice is dry, nothing else changes. */
  reverb: Reverb | null
  peers: Map<number, Peer>
  /** Detached peers still fading out. */
  fading: Peer[]
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
  /**
   * The host's one listener for every sound's start, change and stop (captions.ts CaptionTrack.push), called with a
   * fresh event carrying the sound's world point and this clock's time; what it throws is caught, never the sound's.
   */
  onSound: ((e: CaptionEvent) => void) | null = null
  /** The clock's last reading (currentTime), kept once the context is gone so `clock` never runs backwards. */
  private lastTime = 0
  /** The listener's room as of the last control pass (speak() and attachPeer() place against it). */
  private room: Room | undefined
  /** Caption states: the cabin, and the murmur bed with its hysteresis (CAPTIONS.ambientOn/Off, busy). */
  private cabinOn = false
  private murmurOn = false
  private murmurBusy = false
  private murmurAt = -Infinity
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

  /** One control pass: listener, room, car voices, murmur beds, walk tones, speech and peers; their captions. */
  private control(f: AudioFrame, ctx: AudioContext, g: Graph, dt: number): void {
    const L = f.listener
    if (!Number.isFinite(L.x + L.y + L.z + L.yaw + L.pitch)) return
    const now = ctx.currentTime
    this.lastTime = now
    if (g.babbleJob) this.renderBabbleStep(ctx, g, now)
    this.listen(g, ctx, L.x, L.y, L.z, L.yaw, L.pitch, now)
    this.room = f.room
    // The room's tail: set at once for the first room, swapped behind silent sends after that. Without a room every
    // send stays at nothing (dry): a region has no page-side geometry to find rooms in.
    const rv = g.reverb
    if (rv) this.reverberate(rv, ctx, f.room, now)
    const wet = rv && rv.key !== '' && rv.pendingKey === null ? 1 : 0

    const cars = f.cars
    let lvx = 0, lvz = 0, player = -1
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i]
      if (c.player && Number.isFinite(c.speed + c.heading)) { player = i; lvx = Math.sin(c.heading) * c.speed; lvz = Math.cos(c.heading) * c.speed; break }
    }
    const interior = f.interior && player >= 0
    g.cabin.glide(interior ? CABIN.cutoff : CABIN.open, now, 0.12)
    if (interior !== this.cabinOn) {
      this.cabinOn = interior
      this.emit('cabin', interior ? 'start' : 'stop', 0, Number.NaN, Number.NaN, now)
    }
    const outside = interior ? CABIN.outside : 1

    assignVoices(cars, L.x, L.z, dt, this.slots, this.age)
    for (let j = 0; j < g.voices.length; j++) {
      const v = g.voices[j]
      const next = this.slots[j]
      if (v.car !== next) {
        if (v.car < 0) this.attach(v, next, cars, now, L.x, L.z, lvx, lvz)
        else if (!v.fading) {
          v.fading = true
          v.switchAt = now + VOICE.fade * 6
          v.engineGain.glide(0, now, VOICE.fade)
          v.tyreGain.glide(0, now, VOICE.fade)
          this.silenceVoice(v, now)
        } else if (now >= v.switchAt) this.attach(v, next, cars, now, L.x, L.z, lvx, lvz)
      } else if (v.fading) v.fading = false
      if (v.car < 0 || v.fading || v.car >= cars.length) { v.send?.glide(0, now, REVERB.glide); continue }

      const c = cars[v.car]
      const speed = Math.abs(c.speed)
      v.accel += ((speed - v.speed) / dt - v.accel) * Math.min(1, dt / 0.25)
      v.speed = speed
      const gear = selectGear(speed, v.gear, v.scale)
      const shift = gear > v.gear ? 'up' : gear < v.gear ? 'down' : null
      v.gear = gear
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
      const engine = engineLevel(rpm, load), tyres = tyreLevel(speed)
      v.engineGain.glide(engine * (own ? CABIN.ownEngine : outside), now, 0.08)
      v.tyreGain.glide(tyres * (own ? CABIN.ownTyres : outside), now, 0.08)
      v.send?.glide(own ? 0 : wet * eavesdrop(Math.hypot(x - L.x, z - L.z), 0).reverbSend, now, REVERB.glide)
      v.x = x; v.z = z
      this.captionVoice(v, own, speed, doppler, shift, tyres > engine, now)
    }

    const level = murmurLevel(f.crowd.near, f.crowd.waiting, f.crowd.crossing, f.daylight)
    this.murmur = level * MURMUR.level * outside
    murmurLayout(L.x, L.z, this.layout)
    for (let i = 0; i < g.beds.length; i++) {
      const b = g.beds[i]
      b.pan.place(this.layout[i * 2], MURMUR.height, this.layout[i * 2 + 1], now, 0.3)
      b.gain.glide(this.murmur * murmurSwell(now, i), now, 0.4)
    }
    rv?.beds.glide(wet * eavesdrop(MURMUR.spread, 0).reverbSend, now, REVERB.glide)
    this.captionMurmur(g.babbleJob ? 0 : level * outside, now)

    if (Number.isFinite(f.intersection.x + f.intersection.z)) {
      g.tonePan.place(f.intersection.x, APS.height, f.intersection.z, now, 0.05)
      rv?.tones.glide(wet * eavesdrop(Math.hypot(f.intersection.x - L.x, f.intersection.z - L.z), 0).reverbSend, now, REVERB.glide)
    }
    this.tone(ctx, g.tones.ew, f.walk.ew, outside, now, f.intersection.x, f.intersection.z)
    this.tone(ctx, g.tones.ns, f.walk.ns, outside, now, f.intersection.x, f.intersection.z)
    if (rv) {
      let nearest = Number.NaN
      for (const c of g.cues) if (c.source && c.until > now) { const d = Math.hypot(c.x - L.x, c.z - L.z); if (!(d >= nearest)) nearest = d }
      if (Number.isFinite(nearest)) rv.cues.glide(wet * eavesdrop(nearest, 0).reverbSend, now, REVERB.glide)
    }
    // The voice stays at the speaker's head as they walk (where they were last seen, if a reading is missing), muffled
    // by the walls between them and the listener, fainter still from another room, wetter with distance.
    const sp = f.speaker
    const s = g.speech
    if (s.source && sp && Number.isFinite(sp.x + sp.z)) {
      s.pan.place(sp.x, SPEECH.height, sp.z, now, SPEECH.follow)
      const walls = sp.walls ?? 0
      const m = eavesdrop(Math.hypot(sp.x - L.x, sp.z - L.z), walls, f.room, sp.room)
      s.cut.glide(m.cutoff, now, OCCLUSION.glide)
      s.level.glide(SPEECH.level * m.gain, now, OCCLUSION.glide)
      s.send?.glide(wet * m.reverbSend, now, REVERB.glide)
      const muffled = walls >= 1
      const moved = Math.hypot(sp.x - s.x, sp.z - s.z) > 0.5
      if (moved || muffled !== s.muffled || now - s.captionAt >= CAPTION_REFRESH) {
        s.x = sp.x; s.z = sp.z; s.muffled = muffled; s.captionAt = now
        this.emit('speech', 'change', s.agent, sp.x, sp.z, now, { text: s.text, label: s.label, agent: s.agent, detail: muffled ? 'muffled' : 'clear' })
      }
    }
    if (f.peers) for (const p of f.peers) {
      const peer = g.peers.get(p.id)
      if (peer && Number.isFinite(p.x + p.z)) this.movePeer(peer, p.x, p.z, p.walls ?? 0, p.room, now, SPEECH.follow)
    }
    for (const peer of g.peers.values()) {
      if (peer.live && now - peer.captionAt >= CAPTION_REFRESH) {
        peer.captionAt = now
        this.emit('peer', 'start', peer.id, peer.x, peer.z, now, { label: peer.label, agent: peer.id })
      }
      peer.send?.glide(peer.live ? wet * eavesdrop(Math.hypot(peer.x - L.x, peer.z - L.z), 0).reverbSend : 0, now, REVERB.glide)
    }
    for (let i = g.fading.length - 1; i >= 0; i--) {
      if (now >= g.fading[i].detachAt) { releasePeer(g.fading[i]); g.fading.splice(i, 1) }
    }
  }

  /**
   * The room's impulse: the first room sets it at once (the sends are still at nothing); a bucket change after that
   * waits REVERB.swap while the sends glide to nothing, then swaps. A room returning to the set bucket cancels the wait.
   */
  private reverberate(rv: Reverb, ctx: AudioContext, room: Room | undefined, now: number): void {
    if (!room) return
    const key = roomKey(room)
    if (key === rv.key) { rv.pendingKey = null; return }
    if (rv.key !== '') {
      if (rv.pendingKey !== key) { rv.pendingKey = key; rv.swapAt = now + REVERB.swap; return }
      if (now < rv.swapAt) return
    }
    let buffer = rv.cache.get(key)
    if (!buffer) {
      if (rv.cache.size >= REVERB.cache) rv.cache.clear()
      const rt60 = sabineRt60(room)
      buffer = ctx.createBuffer(1, impulseLength(rt60, SYNTH_RATE), SYNTH_RATE)
      renderImpulse(rt60, SYNTH_RATE, REVERB.seed, buffer.getChannelData(0))
      rv.cache.set(key, buffer)
    }
    rv.convolver.buffer = buffer
    rv.key = key
    rv.pendingKey = null
  }

  /** A car voice's captions: its motion word (with a Doppler dead band so a crossing car does not flap), gear shifts, tyres. */
  private captionVoice(v: CarVoice, own: boolean, speed: number, doppler: number, shift: 'up' | 'down' | null, tyres: boolean, now: number): void {
    if (own) {
      // The driver's own car is not captioned (the cabin line says it all); a voice that becomes the driven car ends its line.
      if (v.word !== 'own') { this.silenceVoice(v, now); v.word = 'own' }
      return
    }
    const word = speed < 0.5 ? 'idle' : doppler > 1.01 ? 'approaching' : doppler < 0.99 ? 'passing' : v.word === 'approaching' || v.word === 'passing' ? v.word : 'passing'
    if (v.word === '' || v.word === 'own') {
      v.word = word
      v.captionAt = now
      this.emit('engine', 'start', v.car, v.x, v.z, now, { detail: word })
    } else if (word !== v.word) {
      v.word = word
      v.captionAt = now
      this.emit('engine', 'change', v.car, v.x, v.z, now, { detail: word })
    } else if (shift !== null) {
      v.captionAt = now
      this.emit('engine', 'change', v.car, v.x, v.z, now, { detail: shift })
    } else if (now - v.captionAt >= CAPTION_REFRESH) {
      v.captionAt = now
      this.emit('engine', 'start', v.car, v.x, v.z, now, { detail: word })
      if (v.tyres) this.emit('tyres', 'start', v.car, v.x, v.z, now)
    }
    if (tyres !== v.tyres) {
      v.tyres = tyres
      this.emit('tyres', tyres ? 'start' : 'stop', v.car, v.x, v.z, now)
    }
  }

  /** Ends a car voice's captions (released, fading, or become the driven car). */
  private silenceVoice(v: CarVoice, now: number): void {
    if (v.word !== '' && v.word !== 'own') this.emit('engine', 'stop', v.car, v.x, v.z, now)
    if (v.tyres) this.emit('tyres', 'stop', v.car, v.x, v.z, now)
    v.word = ''
    v.tyres = false
  }

  /** The murmur's caption, at the first bed: on past ambientOn, off under ambientOff, 'busy' past CAPTIONS.busy. */
  private captionMurmur(level: number, now: number): void {
    const x = this.layout[0], z = this.layout[1]
    if (!this.murmurOn) {
      if (level < CAPTIONS.ambientOn) return
      this.murmurOn = true
      this.murmurBusy = level >= CAPTIONS.busy
      this.murmurAt = now
      this.emit('murmur', 'start', 0, x, z, now, { detail: this.murmurBusy ? 'busy' : 'quiet' })
      return
    }
    if (level < CAPTIONS.ambientOff) {
      this.murmurOn = false
      this.emit('murmur', 'stop', 0, x, z, now)
      return
    }
    const busy = level >= CAPTIONS.busy
    if (busy !== this.murmurBusy) {
      this.murmurBusy = busy
      this.murmurAt = now
      this.emit('murmur', 'change', 0, x, z, now, { detail: busy ? 'busy' : 'quiet' })
    } else if (now - this.murmurAt >= CAPTION_REFRESH) {
      this.murmurAt = now
      this.emit('murmur', 'start', 0, x, z, now, { detail: busy ? 'busy' : 'quiet' })
    }
  }

  /** Reports one sound event to `onSound` (a fresh object each time); a listener that throws cannot take the pass down. */
  private emit(kind: SoundKind, phase: SoundPhase, source: number, x: number, z: number, t: number, extra?: { text?: string; label?: string; agent?: number; detail?: string }): void {
    const fn = this.onSound
    if (!fn) return
    const e: CaptionEvent = { kind, phase, source, x, z, t }
    if (extra) {
      if (extra.text !== undefined) e.text = extra.text
      if (extra.label !== undefined) e.label = extra.label
      if (extra.agent !== undefined) e.agent = extra.agent
      if (extra.detail !== undefined) e.detail = extra.detail
    }
    try { fn(e) } catch { /* the listener's fault, never the sound's */ }
  }

  /** The clock every onSound event's `t` is on (the audio context's time, s); held where it stopped once the context is gone. */
  get clock(): number {
    const ctx = this.ctx
    if (ctx && ctx.state !== 'closed') this.lastTime = ctx.currentTime
    return this.lastTime
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
    return this.shot('cue', x, z)
  }

  /** The ping's cue where (x, z) is (08_Swarm/ping.ts): a mark the operator set. As cue(), on the same voices. */
  cuePing(x: number, z: number): boolean {
    return this.shot('ping', x, z)
  }

  private shot(kind: 'cue' | 'ping', x: number, z: number): boolean {
    const ctx = this.ctx, g = this.graph
    if (!ctx || !g || !this.enabled || ctx.state !== 'running' || !representable(x) || !representable(z)) return false
    try {
      const now = ctx.currentTime
      const buffer = kind === 'ping' ? g.ping : g.cue
      // A free voice, or else the one closest to finishing (its shot is cut: the newest request matters more).
      let slot = g.cues[0]
      for (const c of g.cues) if (c.until < slot.until) slot = c
      const index = g.cues.indexOf(slot)
      if (slot.source) {
        stopQuietly(slot.source)
        this.emit(slot.kind, 'stop', index, slot.x, slot.z, now)
      }
      slot.pan.jump(x, CUE.height, z, now)
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(slot.gain)
      src.onended = () => {
        src.disconnect()
        if (slot.source === src) {
          slot.source = null
          this.emit(slot.kind, 'stop', index, slot.x, slot.z, this.clock)
        }
      }
      src.start(now + 0.01)
      slot.source = src
      slot.kind = kind
      slot.x = x
      slot.z = z
      slot.until = now + 0.01 + buffer.length / buffer.sampleRate
      this.emit(kind, 'start', index, x, z, now)
      return true
    } catch {
      this.fail()
      return false
    }
  }

  /**
   * A peer's voice (a MediaStream the host received; nothing is opened here) placed in the space like speech: its own
   * HRTF panner, level and wall filter, and a reverb send where there is one. Null, never a throw, when the soundscape
   * cannot sound or the browser has no MediaStream source. The voice is silent until `place()` puts it somewhere; it
   * then follows AudioFrame.peers. A second attach of the same id lets the first go.
   */
  attachPeer(stream: MediaStream, id: number, label?: string): PeerVoice | null {
    const ctx = this.ctx, g = this.graph
    if (!ctx || !g || this.silence() !== null || typeof ctx.createMediaStreamSource !== 'function' || !Number.isFinite(id)) return null
    try {
      const had = g.peers.get(id)
      if (had) this.detachPeer(g, had)
      const source = ctx.createMediaStreamSource(stream)
      const pan = new Spatial(ctx, SPEECH.refDistance, SPEECH.rolloff)
      pan.node.connect(g.bus)
      const wall = ctx.createBiquadFilter()
      wall.type = 'lowpass'
      wall.Q.value = 0.7
      wall.frequency.value = OCCLUSION.open
      wall.connect(pan.node)
      const gain = ctx.createGain()
      gain.gain.value = 0
      gain.connect(wall)
      source.connect(gain)
      const peer: Peer = {
        id, label, source, gain, level: new Knob(gain.gain, 0.001), wall, cut: new Knob(kRate(wall.frequency), 1), pan,
        send: g.reverb ? sendFor(ctx, pan.node, g.reverb.convolver) : null,
        live: false, detachAt: Infinity, x: Number.NaN, z: Number.NaN, muffled: false, captionAt: -Infinity,
      }
      g.peers.set(id, peer)
      return Object.freeze({
        place: (x: number, z: number, walls = 0, room?: Room) => {
          const c = this.ctx
          if (c && this.graph?.peers.get(id) === peer && representable(x) && representable(z)) this.movePeer(peer, x, z, walls, room, c.currentTime, SPEECH.follow)
        },
        detach: () => {
          const gg = this.graph
          if (gg && gg.peers.get(id) === peer) this.detachPeer(gg, peer)
        },
      })
    } catch {
      return null
    }
  }

  /** Places a peer's voice (the first placement jumps and swells the level in; after that it glides), and captions it. */
  private movePeer(peer: Peer, x: number, z: number, walls: number, room: Room | undefined, now: number, tau: number): void {
    if (peer.detachAt < Infinity) return
    const L = this.listenerAt
    const m = eavesdrop(Math.hypot(x - L[0], z - L[2]), walls, this.room, room)
    const muffled = walls >= 1
    peer.pan.place(x, SPEECH.height, z, now, tau)
    if (!peer.live) {
      peer.live = true
      peer.cut.jump(m.cutoff, now)
      peer.level.glide(SPEECH.level * m.gain, now, 0.05)
      peer.x = x; peer.z = z; peer.muffled = muffled; peer.captionAt = now
      this.emit('peer', 'start', peer.id, x, z, now, { label: peer.label, agent: peer.id })
      return
    }
    peer.cut.glide(m.cutoff, now, OCCLUSION.glide)
    peer.level.glide(SPEECH.level * m.gain, now, OCCLUSION.glide)
    if (Math.hypot(x - peer.x, z - peer.z) > 0.5 || muffled !== peer.muffled) {
      peer.x = x; peer.z = z; peer.muffled = muffled; peer.captionAt = now
      this.emit('peer', 'change', peer.id, x, z, now, { label: peer.label, agent: peer.id, detail: muffled ? 'muffled' : 'clear' })
    }
  }

  /** Fades a peer's voice out; its nodes are released once the fade is inaudible (the next control pass past it). */
  private detachPeer(g: Graph, peer: Peer): void {
    g.peers.delete(peer.id)
    const now = this.clock
    peer.level.glide(0, now, SPEECH.fade)
    peer.send?.glide(0, now, SPEECH.fade)
    peer.detachAt = now + SPEECH.fade * 6
    if (peer.live) this.emit('peer', 'stop', peer.id, peer.x, peer.z, now, { label: peer.label, agent: peer.id })
    peer.live = false
    g.fading.push(peer)
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
   * Web Audio can hold. `text` (the words, already screened) and `who` (the speaker's number and label) go to the
   * caption only; the room the speaker stands in reaches the voice with the next AudioFrame.speaker.
   */
  speak(buffer: AudioBuffer, x: number, z: number, walls = 0, text?: string, who?: { agent?: number; label?: string }): { readonly ended: Promise<void>; stop(): void } {
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
    sp.send?.jump(0, now)
    sp.agent = who?.agent !== undefined && Number.isFinite(who.agent) ? who.agent : 0
    sp.label = who?.label
    sp.text = text
    sp.x = x; sp.z = z; sp.muffled = walls >= 1; sp.captionAt = now
    this.emit('speech', 'start', sp.agent, x, z, now, { text, label: sp.label, agent: sp.agent, detail: sp.muffled ? 'muffled' : 'clear' })
    const envelope = ctx.createGain()
    envelope.connect(sp.gain)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(envelope)
    let finish: () => void = noop
    const ended = new Promise<void>((resolve) => { finish = resolve })
    const end = (): void => {
      finish()
      if (sp.source === src) {
        sp.source = null; sp.envelope = null; sp.done = null
        this.emit('speech', 'stop', sp.agent, sp.x, sp.z, this.clock, { agent: sp.agent })
      }
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
    this.emit('speech', 'stop', sp.agent, sp.x, sp.z, now, { agent: sp.agent })
    done?.()
  }

  /** `voices` counts sources currently audible: car voices, murmur beds, walk tones, cues, speech and placed peers. */
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
      for (const p of g.peers.values()) if (p.live) voices++
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
      // The peers' voices with it (their captions end; the streams themselves are the host's).
      for (const p of g.peers.values()) this.detachPeer(g, p)
      for (const p of g.fading) releasePeer(p)
      g.fading.length = 0
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
    // The room's reverberation, where the browser has a convolver: every group's send fans into it, and it returns to
    // the bus (muffled with everything else in the cabin). Without one the graph is exactly the dry graph.
    let convolver: ConvolverNode | null = null
    if (typeof ctx.createConvolver === 'function') {
      convolver = ctx.createConvolver()
      // The rendered impulse has unit energy: the sends alone set the wetness.
      try { convolver.normalize = false } catch { /* read-only in some engines: the tail is then a little louder */ }
      convolver.connect(bus)
    }
    const send = (from: AudioNode): Knob | null => (convolver ? sendFor(ctx, from, convolver) : null)

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
        send: send(pan.node), x: Number.NaN, z: Number.NaN, word: '', tyres: false, captionAt: -Infinity,
      })
    }

    const babble = ctx.createBuffer(1, SYNTH_RATE * MURMUR.seconds, SYNTH_RATE)
    const babbleJob = new BabbleRender(babble.getChannelData(0), SYNTH_RATE, 0xb4bb1e)
    const beds: Bed[] = []
    const bedSend = convolver ? ctx.createGain() : null
    if (bedSend && convolver) { bedSend.gain.value = 0; bedSend.connect(convolver) }
    for (let i = 0; i < MURMUR.sources; i++) {
      const pan = new Spatial(ctx, MURMUR.refDistance, MURMUR.rolloff)
      hrtf &&= pan.hrtf
      pan.node.connect(bus)
      if (bedSend) pan.node.connect(bedSend)
      const input = ctx.createGain()
      input.gain.value = 0
      input.connect(pan.node)
      beds.push({ pan, input, gain: new Knob(input.gain, 0.002), source: null })
    }

    const tonePan = new Spatial(ctx, APS.refDistance, APS.rolloff)
    hrtf &&= tonePan.hrtf
    tonePan.node.connect(bus)
    const toneSend = send(tonePan.node)
    const tone = (axis: 'ew' | 'ns'): Tone => {
      const buffer = ctx.createBuffer(1, signalToneLength(axis, SYNTH_RATE), SYNTH_RATE)
      renderSignalTone(axis, SYNTH_RATE, buffer.getChannelData(0))
      const gain = ctx.createGain()
      gain.gain.value = APS.level
      gain.connect(tonePan.node)
      return { axis, buffer, gain, level: new Knob(gain.gain, 0.002), source: null, envelope: null, on: false, captionAt: -Infinity }
    }

    const cue = ctx.createBuffer(1, cueLength(SYNTH_RATE), SYNTH_RATE)
    renderCue(SYNTH_RATE, cue.getChannelData(0))
    const ping = ctx.createBuffer(1, pingLength(SYNTH_RATE), SYNTH_RATE)
    renderPing(SYNTH_RATE, ping.getChannelData(0))
    const cues: Cue[] = []
    const cueSend = convolver ? ctx.createGain() : null
    if (cueSend && convolver) { cueSend.gain.value = 0; cueSend.connect(convolver) }
    for (let i = 0; i < CUE.slots; i++) {
      const pan = new Spatial(ctx, CUE.refDistance, CUE.rolloff)
      hrtf &&= pan.hrtf
      pan.node.connect(bus)
      if (cueSend) pan.node.connect(cueSend)
      const gain = ctx.createGain()
      gain.connect(pan.node)
      cues.push({ pan, gain, source: null, until: -Infinity, kind: 'cue', x: Number.NaN, z: Number.NaN })
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
      send: send(speechPan.node), source: null, envelope: null, done: null,
      agent: 0, label: undefined, text: undefined, x: Number.NaN, z: Number.NaN, muffled: false, captionAt: -Infinity,
    }

    const reverb: Reverb | null = convolver && bedSend && toneSend && cueSend
      ? { convolver, key: '', pendingKey: null, swapAt: 0, cache: new Map(), beds: new Knob(bedSend.gain, 0.002), tones: toneSend, cues: new Knob(cueSend.gain, 0.002) }
      : null

    const l = ctx.listener
    const params = typeof (l as Partial<AudioListener>).positionX === 'object'
    const listener = params
      ? [l.positionX, l.positionY, l.positionZ, l.forwardX, l.forwardY, l.forwardZ, l.upX, l.upY, l.upZ].map((p, i) => new Knob(kRate(p), i < 3 ? 0.01 : 0.001))
      : null
    return {
      master: new Knob(master.gain, 0.0005), cabin: new Knob(kRate(cabin.frequency), 0, 0.01), bus, limiter, voices, beds, babble, babbleJob,
      tones: { ew: tone('ew'), ns: tone('ns') }, tonePan, cue, ping, cues, speech, reverb, peers: new Map(), fading: [], listener, hrtf,
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

  /**
   * Voice `v` takes car `next` (−1 = none) while silent: parameters jump to the new car, then the gains fade in. Its
   * caption starts with the car's motion word as heard from the listener at (lx, lz) moving with (lvx, lvz).
   */
  private attach(v: CarVoice, next: number, cars: readonly CarSample[], now: number, lx: number, lz: number, lvx: number, lvz: number): void {
    v.car = next
    v.fading = false
    v.engineGain.jump(0, now)
    v.tyreGain.jump(0, now)
    v.word = ''
    v.tyres = false
    if (next < 0 || next >= cars.length) { v.car = -1; return }
    const c = cars[next]
    const speed = Math.abs(c.speed)
    v.scale = carTimbre(next)
    v.speed = speed
    v.accel = 0
    v.gear = selectGear(speed, 0, v.scale)
    const rpm = engineRpm(speed, v.gear, v.scale)
    const fx = Math.sin(c.heading), fz = Math.cos(c.heading)
    const x = c.x + fx * VOICE.nose, z = c.z + fz * VOICE.nose
    v.pan.jump(x, VOICE.height, z, now)
    v.freq.jump(rpm * ENGINE.fundamental * v.scale, now)
    v.engineCut.jump(engineCutoff(rpm, 0.3), now)
    v.tyreCut.jump(tyreCutoff(speed), now)
    v.x = x; v.z = z
    if (c.player) { v.word = 'own'; return }
    const doppler = dopplerFactor(x, z, fx * c.speed, fz * c.speed, lx, lz, lvx, lvz)
    v.word = speed < 0.5 ? 'idle' : doppler >= 1 ? 'approaching' : 'passing'
    v.captionAt = now
    this.emit('engine', 'start', next, x, z, now, { detail: v.word })
    if (tyreLevel(speed) > engineLevel(rpm, 0.3)) {
      v.tyres = true
      this.emit('tyres', 'start', next, x, z, now)
    }
  }

  /**
   * Walk tone for one axis: a fresh looping source per walk phase, so the pattern starts on its first note
   * (the loop opens on silence). Each phase fades out on its own envelope, so a phase that starts while the
   * previous one's tail is still fading (a clock jump) neither revives that tail nor cuts it off. Captioned at the
   * intersection (x, z), the north–south tone as source 0 and the east–west one as 1.
   */
  private tone(ctx: AudioContext, t: Tone, want: boolean, outside: number, now: number, x: number, z: number): void {
    t.level.glide(APS.level * outside, now, 0.03)
    const source = t.axis === 'ns' ? 0 : 1
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
      t.captionAt = now
      this.emit('walk-signal', 'start', source, x, z, now, { detail: t.axis })
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
      this.emit('walk-signal', 'stop', source, x, z, now, { detail: t.axis })
    } else if (t.on && now - t.captionAt >= CAPTION_REFRESH) {
      t.captionAt = now
      this.emit('walk-signal', 'start', source, x, z, now, { detail: t.axis })
    }
  }
}

function stopQuietly(s: AudioScheduledSourceNode, when?: number): void {
  try { s.stop(when) } catch { /* already stopped */ }
}

/** A reverb send: `from` → a gain at nothing (a-rate, so it fades smoothly) → the convolver. */
function sendFor(ctx: AudioContext, from: AudioNode, convolver: ConvolverNode): Knob {
  const g = ctx.createGain()
  g.gain.value = 0
  from.connect(g)
  g.connect(convolver)
  return new Knob(g.gain, 0.002)
}

/** Disconnects a detached peer's nodes once its fade is inaudible (the stream itself stays the host's; its send, fed by nothing, is inert). */
function releasePeer(p: Peer): void {
  try { p.source.disconnect(); p.gain.disconnect(); p.wall.disconnect(); p.pan.node.disconnect() } catch { /* already gone */ }
}
