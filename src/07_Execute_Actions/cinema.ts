// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the cinema camera's arithmetic, kept pure (no three.js, no DOM) so every number
 * in it is testable: the phase-locked 24 fps pacer that decides which animation frames are drawn, the 180° shutter
 * (1/48 s) as a scale on the velocity buffer, the cut test that drops the blur across a jump, and the film response
 * the post chain applies after its ND stage (postfx.ts builds the GPU twin from FILM). None of it reaches the
 * physics realm: the engine still polls input and sends a step on every animation frame; only drawing waits for
 * the pacer, and nothing here changes a coordinate.
 * What breaks if it is removed? The engine draws every animation frame, the shutter has no exposure time, and the
 * post chain has no curve.
 */

/** The camera: 24 frames per second through a 180° shutter. */
export const CINEMA = Object.freeze({
  fps: 24,
  /** Shutter angle, degrees: the exposure lasts angle/360 of a frame. */
  shutterAngle: 180,
  /** Presented frames further apart than this are a stall (a hitch, a hidden tab), not an exposure: no blur, ms. */
  maxIntervalMs: 250,
  /** The camera moving faster than this between two presented frames is a cut (a teleport), not motion, m/s. */
  maxCameraSpeed: 90,
})

/** Seconds the shutter is open: 180° at 24 fps is 1/48 s. */
export const SHUTTER_SECONDS = CINEMA.shutterAngle / 360 / CINEMA.fps

/** Tick intervals the refresh estimate is taken from. */
const REFRESH_WINDOW = 15
/** Presented frames the rate is measured over (24 intervals: one second at 24 fps). */
const RATE_WINDOW = 25
const DEFAULT_REFRESH_MS = 1000 / 60
/** A tick interval this long or longer is a stall, not the display's refresh, ms. */
const STALL_MS = 250
/** Share of each frame's lateness the phase offset takes up (slow: about 50 frames, two seconds, to settle). */
const PHASE_GAIN = 0.02
/**
 * No two frames closer than this share of a period (25 ms at 24 fps): below every steady cadence's short hold (33 ms
 * at 30, 60 and 90 Hz; 36 ms at 165 Hz) with room for 4 ms of timestamp jitter, so it only ever stops a burst the
 * refresh estimate would let through (the first ticks, a display whose rAF cadence swings).
 */
const MIN_HOLD = 0.6

/**
 * Phase-locked frame pacer. Presented frames are due every 1000/24 ms; each animation frame (tick) is presented
 * when it is the tick nearest the next due time, i.e. no more than half a refresh early. Every presented frame
 * moves the due time on by exactly one period, so on a steady display the long-run rate is 24.000 whatever the
 * refresh: 60 Hz gives alternating holds of 2 and 3 ticks (the 3:2 cadence), 120 and 144 Hz every 5th and 6th tick,
 * 30 Hz four ticks in five.
 *
 * At 60 Hz every other due time falls exactly between two ticks, where a tenth of a millisecond of timestamp
 * rounding decides which tick takes the frame: left alone, the cadence stutters (2,2 then 3,3) several times a
 * second. So the grid carries a phase offset, bounded to half a refresh and nudged by a fiftieth of each frame's
 * lateness, which settles where the frames' lateness averages zero: due times sit clear of the midpoints (a quarter
 * refresh either side at 60 Hz). It is a phase, never a rate: the grid still advances exactly one period a frame.
 *
 * A tick later than any steady cadence puts one (more than ¾ of a refresh past due: a dropped frame, a stall, a
 * hidden tab) is presented and the cadence restarts on it (keeping the learned phase), so the next frame is a full
 * period away: the pacer never hurries frames to catch up, and no two frames are ever closer than MIN_HOLD of a
 * period. A refresh too slow for 24 presents every tick. A clock that runs backwards re-anchors. Allocation-free.
 */
export class FramePacer {
  readonly periodMs: number
  /** Frames presented since construction. */
  frames = 0
  /** The next frame's due time on the exact grid, before the phase offset (NaN: anchor on the next tick). */
  private base = Number.NaN
  /** The grid's offset against the display's ticks, ms, within ±half a refresh. */
  private phase = 0
  private last = Number.NaN
  private readonly intervals = new Float64Array(REFRESH_WINDOW)
  private readonly scratch = new Float64Array(REFRESH_WINDOW)
  private filled = 0
  private next = 0
  private refresh = DEFAULT_REFRESH_MS
  private readonly presented = new Float64Array(RATE_WINDOW)

  constructor(fps: number = CINEMA.fps) {
    if (!(fps > 0) || !Number.isFinite(fps)) throw new RangeError(`frame rate must be a positive number, not ${fps}`)
    this.periodMs = 1000 / fps
  }

  /**
   * The display's refresh interval, ms: the lower quartile of the last 15 tick intervals (60 Hz until there are any).
   * A dropped or late frame only ever lengthens an interval, so the short ones are the refresh.
   */
  get refreshMs(): number {
    return this.refresh
  }

  /** Time of the latest presented frame, ms (NaN before the first). */
  get lastPresentMs(): number {
    return this.frames > 0 ? this.presented[(this.frames - 1) % RATE_WINDOW] : Number.NaN
  }

  /** One animation frame at `nowMs` (a monotonic clock): true when it is to be presented. */
  tick(nowMs: number): boolean {
    if (!Number.isFinite(nowMs)) return false
    const gap = nowMs - this.last
    this.last = nowMs
    if (gap > 0 && gap < STALL_MS) this.learn(gap)
    if (gap < 0) this.base = Number.NaN
    // The first tick, or a clock that ran backwards: present and anchor the grid here.
    if (Number.isNaN(this.base)) {
      this.base = nowMs + this.periodMs
      return this.present(nowMs)
    }
    const half = this.refresh / 2
    const late = nowMs - (this.base + this.phase)
    if (late < -half || nowMs - this.lastPresentMs < this.periodMs * MIN_HOLD) return false
    // A steady cadence is never more than half a refresh late; ¾ leaves room for clock rounding at the ties.
    if (late > this.refresh * 0.75) {
      this.base = nowMs + this.periodMs
    } else {
      this.base += this.periodMs
      this.phase = Math.min(half, Math.max(-half, this.phase + PHASE_GAIN * late))
    }
    return this.present(nowMs)
  }

  /** Presented frames per second over the last 24 intervals (0 until two frames, or after a second without one). */
  fps(nowMs: number): number {
    const n = Math.min(this.frames, RATE_WINDOW)
    if (n < 2) return 0
    const newest = this.presented[(this.frames - 1) % RATE_WINDOW]
    const oldest = this.presented[(this.frames - n) % RATE_WINDOW]
    if (!(nowMs - newest < 1000) || !(newest > oldest)) return 0
    return ((n - 1) * 1000) / (newest - oldest)
  }

  private present(nowMs: number): true {
    this.presented[this.frames % RATE_WINDOW] = nowMs
    this.frames++
    return true
  }

  private learn(gap: number): void {
    this.intervals[this.next] = gap
    this.next = (this.next + 1) % REFRESH_WINDOW
    if (this.filled < REFRESH_WINDOW) this.filled++
    const s = this.scratch.subarray(0, this.filled)
    s.set(this.intervals.subarray(0, this.filled))
    s.sort()
    this.refresh = s[(this.filled - 1) >> 2]
  }
}

/**
 * The velocity buffer holds each pixel's motion from the previous presented frame to this one; the shutter was open
 * for SHUTTER_SECONDS of that interval. Returns the fraction (the blur's scale: 0.625 after a 2-refresh hold at
 * 60 Hz, 0.417 after a 3-refresh one, 0.5 at an even 24), never more than 1, and 0 when the interval is not an
 * exposure (no previous frame, a stall, a broken clock).
 */
export function shutterScale(intervalMs: number): number {
  if (!(intervalMs > 0) || intervalMs > CINEMA.maxIntervalMs) return 0
  return Math.min(1, (SHUTTER_SECONDS * 1000) / intervalMs)
}

/** Where the camera was when a frame was presented, and from which seat (-1 on foot, else the car's index). */
export interface CameraMark { x: number; y: number; z: number; seat: number }

/**
 * A cut: the two presented frames are not one continuous shot, so nothing may be smeared across them. The first
 * frame, a stall, a seat change (getting into or out of a car turns and moves the head at once), or the camera
 * covering more than CINEMA.maxCameraSpeed (a teleport). A fast head turn is not a cut: film smears it.
 */
export function isCut(prev: CameraMark | null, cur: CameraMark, intervalMs: number): boolean {
  if (prev === null || shutterScale(intervalMs) === 0 || prev.seat !== cur.seat) return true
  const d = Math.hypot(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z)
  return !(d <= (CINEMA.maxCameraSpeed * intervalMs) / 1000)
}

/**
 * The shutter's scale for the frame about to be drawn (0: no blur): shutterScale of the interval since the last drawn
 * frame, unless this frame is a cut, or is drawn without the post chain (no velocity buffer), or `prev` is null
 * because the last one was (its motion history is stale).
 */
export function exposureFor(prev: CameraMark | null, cur: CameraMark, intervalMs: number, post: boolean): number {
  return !post || isCut(prev, cur, intervalMs) ? 0 : shutterScale(intervalMs)
}

/**
 * ACES filmic as three.js applies it to a neutral grey (its input and output matrices map grey to grey), exposure
 * already applied: the curve cinema mode replaces, mirrored here to calibrate the film curve and to test against.
 */
export function acesGrey(x: number): number {
  const v = x / 0.6
  const a = v * (v + 0.0245786) - 0.000090537
  const b = 0.983729 * v * (v + 0.432951) + 0.238081
  const y = a / b
  return y > 0 ? (y < 1 ? y : 1) : 0
}

/** The largest value the half-float scene target holds; the film curve's input is clamped to it (so inf is white). */
export const HDR_MAX = 65504

/**
 * The film response, y = xⁿ / (xⁿ + σⁿ) per channel on the scene-linear light after the ND stage. On a log-exposure
 * axis it is an S like a film's characteristic curve: a toe that falls as a power of the exposure (no black offset,
 * so shadow detail survives below where ACES clips to zero), a straight portion of slope n(1 − y), and a shoulder that
 * approaches white without a knee (highlights compress, they never clip). σ puts mid-grey where ACES put it under
 * full daylight (exposure 0.56, the default 17:00 start), so the city keeps its brightness.
 */
export const FILM = (() => {
  const contrast = 1.5
  const anchor = 0.18 * 0.56
  const y = acesGrey(anchor)
  return Object.freeze({ contrast, anchor, sigma: anchor * ((1 - y) / y) ** (1 / contrast) })
})()

/** The film response for one channel (CPU twin of postfx.ts's shader). 0 for anything not positive. */
export function filmCurve(x: number): number {
  if (!(x > 0)) return 0
  const p = (Math.min(x, HDR_MAX) / FILM.sigma) ** FILM.contrast
  return p / (p + 1)
}

/** The ND stage's transmission for a strength in stops (1 stop halves the light). */
export function ndGain(stops: number): number {
  return Number.isFinite(stops) ? 2 ** -stops : 1
}

/** Optical density of an ND of `stops` (ND 0.3 is one stop). */
export function ndDensity(stops: number): number {
  return stops * Math.log10(2)
}
