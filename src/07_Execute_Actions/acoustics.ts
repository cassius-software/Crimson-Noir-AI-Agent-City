/**
 * Why does this file exist? It is the room acoustics of the city as pure maths, so the soundscape (audio.ts) can give
 * every voice the space it stands in: the 'room' a listener or a speaker occupies (there are no interiors; buildings
 * are solid boxes, so a room is the street canyon, the intersection's clear square or the open ground the probe stands
 * on, bounded by the nearest building faces of the physics realm's own geometry), its reverberation time by Sabine's
 * formula with the open sky as a fully absorbent ceiling, the transmission loss of the walls a voice is heard through
 * (the masonry table is exactly the occlusion table audio.ts has always used, so muffle() can delegate here without
 * changing a number), the through-the-wall eavesdropping path (fainter across rooms, never silent, wetter with
 * distance), a deterministic rendered impulse response for the convolver (no audio files: exponentially decaying noise,
 * predelay, high frequencies fading first, unit energy), and a bucketed room key so the impulse is swapped only when
 * the room really changes. No I/O, no clock, no Web Audio: every function here runs in Node and is unit-tested.
 * What breaks if it is removed? Every voice sounds dry and the same everywhere; a voice behind a building could only
 * be muffled by a wall count, never placed in another street; the convolver would have nothing to convolve with.
 */
import { CITY, type Box } from '../01_Initialize_World/city.ts'
import { createRng } from '../02_Define_The_Rules/degrees.ts'

export const ACOUSTICS = {
  /** Height the room probe is taken at, m: a standing listener's ears, a speaker's mouth. */
  probeHeight: 1.6,
  /** A face further than this from the probe along its axis does not bound the room, m: that side is open. */
  maxSpan: 120,
  /** A probe with no box nearer than this (in plan, at probe height) stands in the open, m. */
  openReach: 20,
  /** The ceiling an open room is given, m (the sky absorbs everything anyway; this sets the open tail's bucket). */
  openHeight: 12,
  /** Sabine absorption coefficients: facades, pavement, and the sky (an open top is a fully absorbent surface). */
  absorption: { wall: 0.04, ground: 0.03, sky: 1 },
  /** Reverberation time clamp, s. */
  rt60: { min: 0.08, max: 2.2 },
  /** The reverb send rises with distance as wetMax·d/(d + wetDistance): near voices dry, far voices wet. */
  wetDistance: 8,
  wetMax: 0.35,
  /** Level factor of a voice heard from another room (on top of the wall loss): fainter still, never silent. */
  coupling: 0.5,
  /** Transmission loss by wall kind: the low-pass cutoff and level factor through one wall, and through more. */
  wall: {
    /** Cutoff with nothing between, Hz: above hearing, no filtering. */
    open: 20000,
    masonry: { one: { cutoff: 900, gain: 0.35 }, more: { cutoff: 450, gain: 0.18 } },
    glass: { one: { cutoff: 1800, gain: 0.5 }, more: { cutoff: 900, gain: 0.25 } },
  },
  impulse: {
    /** The longest tail rendered, s (the rt60 clamp's ceiling). */
    maxSeconds: 2.2,
    /** Silence before the first reflection, s. */
    predelay: 0.012,
    /** High frequencies fade in this fraction of the broadband rt60. */
    hfDecay: 0.6,
    /** The tail's low-pass starts here (or at 0.45 × the sample rate, whichever is lower), Hz, and falls with time. */
    cutoff: 8000,
    /** The low-pass never falls below this, Hz: the late tail is a low rumble, not a wander about zero. */
    floor: 200,
  },
} as const

export type WallKind = 'masonry' | 'glass'
export type RoomKind = 'canyon' | 'crossing' | 'open'

/** An axis-aligned room in plan (x0..x1 × z0..z1, m), its height, and what kind of space it is. */
export interface Room {
  x0: number
  z0: number
  x1: number
  z1: number
  height: number
  kind: RoomKind
}

/** A crossing's clear square is wider than a street between lots plus one road width each way, m. */
const CROSSING_WIDTH = 2 * (CITY.pitch / 2 - CITY.lotHalf) + 2 * CITY.roadHalf

/** −ln(10⁻⁶): the decay rate that reaches −60 dB at t = rt60. */
const DECAY_60 = 6.907755278982137

const OPEN_ROOM = (x: number, z: number): Room => ({
  x0: x - ACOUSTICS.maxSpan, z0: z - ACOUSTICS.maxSpan, x1: x + ACOUSTICS.maxSpan, z1: z + ACOUSTICS.maxSpan,
  height: ACOUSTICS.openHeight, kind: 'open',
})

/**
 * The room the probe (x, z, y) stands in: along each of ±x and ±z, the nearest face of a box whose other-axis span
 * and y-range contain the probe (one pass over `boxes` with the same early rejects as wallsBetween: a few
 * microseconds for the city's few hundred boxes; callers cache by cell). A face further than maxSpan does not bound
 * that side. With no box nearer than openReach the probe is in the open; with both spans wider than a crossing's
 * clear square (the rays escape down the street arms) it is at a crossing; otherwise it is in a canyon. The height is
 * the lowest top among the bounding faces, else among the near boxes, else openHeight. A non-finite probe never
 * throws: it is in the open.
 */
export function roomAt(boxes: readonly Box[], x: number, z: number, y: number = ACOUSTICS.probeHeight): Room {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(y)) return OPEN_ROOM(x, z)
  const reach = ACOUSTICS.maxSpan
  let left = x - reach, right = x + reach, back = z - reach, front = z + reach
  let faceTop = Infinity, nearTop = Infinity, nearest = Infinity
  for (const b of boxes) {
    if (b[1] > y || b[4] < y) continue
    if (b[0] > right || b[3] < left || b[2] > front || b[5] < back) continue
    const inZ = b[2] <= z && z <= b[5], inX = b[0] <= x && x <= b[3]
    if (inZ && b[0] > x && b[0] < right) { right = b[0]; faceTop = Math.min(faceTop, b[4]) }
    else if (inZ && b[3] < x && b[3] > left) { left = b[3]; faceTop = Math.min(faceTop, b[4]) }
    if (inX && b[2] > z && b[2] < front) { front = b[2]; faceTop = Math.min(faceTop, b[4]) }
    else if (inX && b[5] < z && b[5] > back) { back = b[5]; faceTop = Math.min(faceTop, b[4]) }
    const dx = Math.max(b[0] - x, 0, x - b[3]), dz = Math.max(b[2] - z, 0, z - b[5])
    const d = Math.hypot(dx, dz)
    if (d <= ACOUSTICS.openReach) { nearTop = Math.min(nearTop, b[4]); nearest = Math.min(nearest, d) }
  }
  if (!(nearest <= ACOUSTICS.openReach)) return OPEN_ROOM(x, z)
  const kind: RoomKind = right - left > CROSSING_WIDTH && front - back > CROSSING_WIDTH ? 'crossing' : 'canyon'
  const height = Number.isFinite(faceTop) ? faceTop : Number.isFinite(nearTop) ? nearTop : ACOUSTICS.openHeight
  return { x0: left, z0: back, x1: right, z1: front, height, kind }
}

/**
 * Sabine's reverberation time, s: RT60 = 0.161·V/A with V = W·L·H and A the absorption of the facades (2H(W + L)),
 * the pavement (W·L) and the open sky (W·L, fully absorbent: that is what keeps a street from ringing like a hall),
 * clamped to ACOUSTICS.rt60. Monotonic in H. An open room has no facades to reflect, so no diffuse field: it gets the
 * shortest tail. A degenerate room (a zero span, a non-finite number) also gets the shortest tail.
 */
export function sabineRt60(room: Room): number {
  const { min, max } = ACOUSTICS.rt60
  if (room.kind === 'open') return min
  const w = Math.abs(room.x1 - room.x0), l = Math.abs(room.z1 - room.z0), h = room.height
  const { wall, ground, sky } = ACOUSTICS.absorption
  const v = w * l * h
  const a = wall * 2 * h * (w + l) + (ground + sky) * w * l
  const t = 0.161 * v / a
  if (!(t > min)) return min
  return t < max ? t : max
}

/** The low-pass cutoff and level factor of a voice heard through `walls` walls of `kind` (none, one, or more). */
export function transmissionLoss(walls: number, kind: WallKind = 'masonry'): { cutoff: number; gain: number } {
  if (!(walls >= 1)) return { cutoff: ACOUSTICS.wall.open, gain: 1 }
  const table = ACOUSTICS.wall[kind] ?? ACOUSTICS.wall.masonry
  return walls >= 2 ? { ...table.more } : { ...table.one }
}

/** True when the two rooms' plan rectangles overlap (a non-finite rectangle overlaps nothing). */
export function sameRoom(a: Room, b: Room): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1
}

/**
 * The through-the-wall path from a source `distance` m away with `walls` walls between: the wall table's cutoff; its
 * level factor, halved again (ACOUSTICS.coupling) when the two rooms are known and differ, so a voice in another
 * street is fainter still but never silent; and the reverb send wetMax·d/(d + wetDistance), 0 at the ear and rising
 * with distance, which is what tells the ear the size of the space. With no rooms given it is exactly the wall table.
 */
export function eavesdrop(distance: number, walls: number, listener?: Room, source?: Room, kind: WallKind = 'masonry'): { gain: number; cutoff: number; reverbSend: number } {
  const loss = transmissionLoss(walls, kind)
  const coupled = listener !== undefined && source !== undefined && !sameRoom(listener, source)
  const d = distance > 0 ? distance : 0
  const reverbSend = Number.isFinite(d) ? ACOUSTICS.wetMax * d / (d + ACOUSTICS.wetDistance) : ACOUSTICS.wetMax
  return { gain: loss.gain * (coupled ? ACOUSTICS.coupling : 1), cutoff: loss.cutoff, reverbSend }
}

/** rt60 made safe for rendering: within [rt60.min, impulse.maxSeconds], the minimum when not a number. */
function renderable(rt60: number): number {
  const lo = ACOUSTICS.rt60.min, hi = ACOUSTICS.impulse.maxSeconds
  if (!(rt60 > lo)) return lo
  return rt60 < hi ? rt60 : hi
}

/** Samples of an impulse response for `rt60` at `sampleRate`: the predelay plus the tail to −60 dB (0 for a bad rate). */
export function impulseLength(rt60: number, sampleRate: number): number {
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) return 0
  return Math.max(1, Math.round((ACOUSTICS.impulse.predelay + renderable(rt60)) * sampleRate))
}

/**
 * Renders a deterministic impulse response into `out` (normally impulseLength samples): `predelay` of silence, then
 * noise under the envelope exp(−6.908·t/rt60), which is −60 dB at t = rt60, through a one-pole low-pass whose cutoff
 * falls with time so high frequencies fade first (at about hfDecay·rt60); the filter's loss of energy is compensated
 * so the broadband envelope stays exact and the tilt only moves energy toward the low end, as air and facades do.
 * The whole response is scaled to unit energy, so the send gain alone sets how wet a voice is. Same seed, same rate,
 * same rt60: the same samples. Cheap: a few tens of thousands of samples, well under a millisecond.
 */
export function renderImpulse(rt60: number, sampleRate: number, seed: number, out: Float32Array): void {
  const n = out.length
  if (n === 0) return
  const rate = sampleRate > 0 && Number.isFinite(sampleRate) ? sampleRate : 1
  const t60 = renderable(rt60)
  const pre = Math.min(n, Math.round(ACOUSTICS.impulse.predelay * rate))
  const rng = createRng(Number.isFinite(seed) ? seed : 0)
  const fc0 = Math.min(ACOUSTICS.impulse.cutoff, 0.45 * rate)
  // The low-pass cutoff falls so that power well above it (∝ cutoff once compensated) reaches −60 dB at hfDecay·rt60.
  const fcRate = DECAY_60 * 2 * (1 / ACOUSTICS.impulse.hfDecay - 1) / t60
  const BLOCK = 32
  let y = 0, a = 0, g = 1, energy = 0
  for (let i = 0; i < pre; i++) out[i] = 0
  for (let i = pre; i < n; i++) {
    const t = (i - pre) / rate
    if ((i - pre) % BLOCK === 0) {
      const fc = Math.max(Math.min(ACOUSTICS.impulse.floor, fc0), fc0 * Math.exp(-fcRate * t))
      a = Math.exp(-2 * Math.PI * fc / rate)
      g = Math.sqrt((1 + a) / (1 - a)) * Math.exp(-DECAY_60 * t / t60)
    }
    y = a * y + (1 - a) * (2 * rng() - 1)
    const s = y * g
    out[i] = s
    energy += s * s
  }
  if (energy > 0) {
    const k = 1 / Math.sqrt(energy)
    for (let i = pre; i < n; i++) out[i] *= k
  }
}

/** Quantise a span to 5 m buckets (0 when not a number). */
function bucket(v: number): number {
  return Number.isFinite(v) ? Math.floor(Math.abs(v) / 5) : 0
}

/**
 * The room's bucket key: kind and its width, length and height to 5 m, so the convolver's impulse is swapped only when
 * the room's bucket changes as the listener walks. An open room's tail does not depend on its footprint (sabineRt60),
 * so every open room of one height shares a key.
 */
export function roomKey(room: Room): string {
  if (room.kind === 'open') return `open:${bucket(room.height)}`
  return `${room.kind}:${bucket(room.x1 - room.x0)}:${bucket(room.z1 - room.z0)}:${bucket(room.height)}`
}
