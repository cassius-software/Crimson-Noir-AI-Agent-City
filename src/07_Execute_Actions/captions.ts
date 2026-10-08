// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the closed-caption feed for every spatial sound the city makes, as pure state and
 * maths, so a player who cannot hear the soundscape (audio.ts) still learns what sounds, where, and how far: a bounded,
 * ordered track of caption records keyed by sound kind and source (a car voice, a murmur bed, the walk signal, a cue
 * slot, a speaker, a peer, a ping), fed by plain start/change/stop events, that merges a continuing sound into its one
 * live line instead of repeating it, keeps a stopped line readable for a short hold, expires what nobody refreshes,
 * ranks speech over ambience, and holds at most a few lines at once; the bearing of a point in the listener's head
 * frame as a clock hour, an eight-way arrow, a left/right word and a rounded distance (the same forward as
 * listenerBasis and the head rig: forward = (−sin yaw, −cos yaw) in the ground plane); and the one-line caption text
 * in the house style, brand-free and civil, with a speaker's words kept verbatim. Allocation-light (records are pooled
 * and reused), deterministic (the clock is an argument), no I/O, no DOM, no Web Audio: it runs in Node and is
 * unit-tested. The soundscape emits the events and the HUD draws the lines; neither is wired here.
 * What breaks if it is removed? Spatial audio has no text counterpart: an approaching car, the walk signal and what a
 * tethered person says would reach only players who can hear them.
 */

/** Every kind of spatial sound the city makes; the walk signal's axis and a car's state ride in `detail`. */
export type SoundKind = 'engine' | 'tyres' | 'murmur' | 'walk-signal' | 'cue' | 'speech' | 'cabin' | 'peer' | 'ping'
export type SoundPhase = 'start' | 'change' | 'stop'

/**
 * One plain event from the soundscape: a sound of `kind` from `source` (the car index, bed, slot, agent number or peer
 * id: identity within the kind, 0 when the kind has one source) started, changed or stopped at the world point (x, z)
 * at clock time `t` (seconds). `text` is a speaker's exact words, `label` a display name the host supplies (a skill
 * bearer's label, a peer's name, a ping's label), `agent` the speaker's number, and `detail` the kind's own word:
 * engine 'approaching' | 'passing' | 'up' | 'down' | 'idle', murmur 'quiet' | 'busy', walk-signal 'ns' | 'ew',
 * speech 'muffled' | 'clear'.
 */
export interface CaptionEvent {
  kind: SoundKind
  phase: SoundPhase
  source: number
  x: number
  z: number
  t: number
  text?: string
  label?: string
  agent?: number
  detail?: string
}

/** A pose in the ground plane: the listener's eye and the way it faces (three.js yaw about Y, as head.ts applies it). */
export interface ListenerPose { x: number; z: number; yaw: number }

/** Eight compass points in the head frame, clockwise from ahead. */
export type BearingWord = 'ahead' | 'ahead right' | 'right' | 'behind right' | 'behind' | 'behind left' | 'left' | 'ahead left'

/** Where a point lies from the listener: a clock hour (12 = ahead, 3 = right), an arrow, a word and rounded metres. */
export interface Bearing {
  /** 1..12; 0 when the point or the pose is not finite. */
  hour: number
  /** One of ARROWS; '' when not finite. */
  arrow: string
  /** One of the eight words; '' when not finite. */
  word: BearingWord | ''
  /** Rounded distance in metres (to 1 m under 10 m, else to 5 m); NaN when not finite. */
  metres: number
}

/** The eight arrows, clockwise from ahead. Plain arrows are lawful hints: letters, numbers, positions and arrows. */
export const ARROWS: readonly string[] = Object.freeze(['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'])
const WORDS: readonly BearingWord[] = Object.freeze(['ahead', 'ahead right', 'right', 'behind right', 'behind', 'behind left', 'left', 'ahead left'])

/** The track's defaults: lines shown, how long a stopped line stays readable, how long a live line lasts unrefreshed. */
export const CAPTIONS = Object.freeze({
  /** Lines `lines()` hands the HUD at most. */
  maxLines: 3,
  /** Records the track keeps at most; beyond it the lowest-ranked record is evicted. */
  capacity: 16,
  /** Seconds a stopped line stays readable. */
  hold: 2.5,
  /** Seconds a stopped speech line stays readable (words take longer to read than a bracket). */
  speechHold: 4,
  /** Seconds a live line lasts without a start or change refreshing it (a sound whose stop never came). */
  ttl: 8,
  /** Ambient level (0..1) at which a murmur or tyre bed is captioned, and below which it stops: hysteresis. */
  ambientOn: 0.05,
  ambientOff: 0.02,
  /** Ambient level at which a murmur reads 'busy' rather than 'quiet'. */
  busy: 0.5,
})

export interface CaptionOptions {
  maxLines?: number
  capacity?: number
  hold?: number
  speechHold?: number
  ttl?: number
  ambientOn?: number
  ambientOff?: number
}

/**
 * One caption record. Reused across sounds: `id` changes each time the record is taken for a new sound, so a view can
 * key on it. `since` is the clock time of the last text change (what `lines()` ranks recency by), `until` the time the
 * record expires (a live line's refresh deadline, a stopped line's end of hold), and x/z the sound's last point.
 */
export interface CaptionLine {
  id: number
  kind: SoundKind
  source: number
  text: string
  live: boolean
  since: number
  until: number
  x: number
  z: number
  hour: number
  arrow: string
  word: BearingWord | ''
  metres: number
}

/** Ranking between kinds: what a player most needs to read first. */
const PRIORITY: Readonly<Record<SoundKind, number>> = Object.freeze({
  speech: 9, peer: 8, ping: 7, cue: 6, 'walk-signal': 5, cabin: 4, engine: 3, tyres: 2, murmur: 1,
})

const TAU = Math.PI * 2

/** Rounded metres: to 1 m under 10 m, else to 5 m. */
export function roundMetres(d: number): number {
  if (!Number.isFinite(d)) return NaN
  return d < 10 ? Math.round(d) : Math.round(d / 5) * 5
}

/** Writes the bearing of (x, z) from the listener into `out`; '' / 0 / NaN when anything is not finite. */
function bearInto(listener: ListenerPose, x: number, z: number, out: Bearing): void {
  const dx = x - listener.x, dz = z - listener.z
  const sy = Math.sin(listener.yaw), cy = Math.cos(listener.yaw)
  // Head frame: forward = (−sin yaw, −cos yaw), right = (cos yaw, −sin yaw).
  const ahead = -dx * sy - dz * cy
  const right = dx * cy - dz * sy
  const d = Math.sqrt(dx * dx + dz * dz)
  if (!Number.isFinite(d) || !Number.isFinite(ahead) || !Number.isFinite(right)) {
    out.hour = 0; out.arrow = ''; out.word = ''; out.metres = NaN
    return
  }
  // Clockwise angle from ahead in [0, 2π); a point at the eye reads as ahead.
  let rel = d > 1e-6 ? Math.atan2(right, ahead) : 0
  if (rel < 0) rel += TAU
  const hour = Math.round(rel / (TAU / 12)) % 12
  const eighth = Math.round(rel / (TAU / 8)) % 8
  out.hour = hour === 0 ? 12 : hour
  out.arrow = ARROWS[eighth]
  out.word = WORDS[eighth]
  out.metres = roundMetres(d)
}

/**
 * The bearing of the world point (x, z) from the listener: a clock hour (12 ahead, 3 right, 6 behind, 9 left), an
 * arrow and a word from the eight compass points of the head frame, and the rounded distance. Pass `out` to reuse an
 * object. Never throws: a non-finite input gives hour 0, no arrow, no word and NaN metres.
 */
export function bearing(listener: ListenerPose, x: number, z: number, out?: Bearing): Bearing {
  const b = out ?? { hour: 0, arrow: '', word: '' as BearingWord | '', metres: NaN }
  bearInto(listener, x, z, b)
  return b
}

/** The speaker's name as the caption shows it: the host's label, else the agent number, else 'Someone'. */
function speakerName(e: CaptionEvent): string {
  if (e.label) return e.label
  if (e.agent !== undefined && Number.isFinite(e.agent)) return `Pedestrian ${e.agent}`
  return 'Someone'
}

/**
 * The bracketed text of an event, or a speaker's words verbatim after their name. '' for a phase that leaves the
 * line's text as it was (every stop but the cabin's, and a change that carries no word of its own).
 */
export function soundText(e: CaptionEvent): string {
  switch (e.kind) {
    case 'engine':
      if (e.phase === 'stop') return ''
      switch (e.detail) {
        case 'approaching': return '[car approaching]'
        case 'passing': return '[car passing]'
        case 'up': return '[car shifting up]'
        case 'down': return '[car shifting down]'
        case 'idle': return '[car idling]'
        default: return e.phase === 'start' ? '[car nearby]' : ''
      }
    case 'tyres':
      return e.phase === 'stop' ? '' : '[tyre noise]'
    case 'murmur':
      if (e.phase === 'stop') return ''
      return e.detail === 'busy' ? '[crowd murmur, busy]' : e.detail === 'quiet' ? '[crowd murmur, quiet]' : e.phase === 'start' ? '[crowd murmur]' : ''
    case 'walk-signal':
      if (e.phase === 'stop') return ''
      return e.detail === 'ns' ? '[walk signal: cuckoo, north–south]' : e.detail === 'ew' ? '[walk signal: chirp, east–west]' : '[walk signal]'
    case 'cue':
      return e.phase === 'stop' ? '' : '[someone coming over]'
    case 'speech': {
      if (e.phase === 'stop') return ''
      const name = speakerName(e)
      if (e.text === undefined) return e.phase === 'start' ? `[${name} speaking]` : ''
      return e.detail === 'muffled' ? `${name} (muffled): ${e.text}` : `${name}: ${e.text}`
    }
    case 'cabin':
      return e.phase === 'stop' ? '[out of the car: outside clear]' : e.phase === 'start' ? '[in the car: outside muffled]' : ''
    case 'peer': {
      if (e.phase === 'stop') return ''
      const name = e.label || (e.agent !== undefined && Number.isFinite(e.agent) ? `player ${e.agent}` : 'a player')
      if (e.text !== undefined) return `${name}: ${e.text}`
      return e.phase === 'start' ? `[voice: ${name}]` : ''
    }
    case 'ping':
      if (e.phase === 'stop') return ''
      return e.label ? `[ping: ${e.label}]` : '[ping]'
  }
}

/**
 * The one-line caption of a record in the house style: the arrow, the text, then the side word and the distance
 * ('↗ [car approaching] · ahead right, 25 m'). A record with no place (the cabin) is the text alone.
 */
export function captionText(line: CaptionLine): string {
  if (!line.arrow || !Number.isFinite(line.metres)) return line.text
  return `${line.arrow} ${line.text} · ${line.word}, ${line.metres} m`
}

/** Rank: higher-priority kinds first, then the most recent text change first. Negative when a ranks before b. */
function rank(a: CaptionLine, b: CaptionLine): number {
  const p = PRIORITY[b.kind] - PRIORITY[a.kind]
  if (p !== 0) return p
  if (a.since !== b.since) return b.since - a.since
  return b.id - a.id
}

function blank(): CaptionLine {
  return { id: 0, kind: 'murmur', source: 0, text: '', live: false, since: 0, until: -Infinity, x: NaN, z: NaN, hour: 0, arrow: '', word: '', metres: NaN }
}

/**
 * The caption feed. One record per (kind, source): a 'start' takes a record (or refreshes the live one it already
 * has, so a continuing sound is never repeated), a 'change' updates its text and place, a 'stop' ends it after the
 * hold. `lines(now)` is what the HUD draws: expired records dropped, the rest ranked speech first and newest first,
 * cut to `maxLines`. The track holds at most `capacity` records and evicts the lowest-ranked when full. Records are
 * pooled and reused; nothing is allocated per event once the pool is full. The clock is whatever the caller passes
 * (seconds); no call reads a clock of its own.
 */
export class CaptionTrack {
  readonly maxLines: number
  readonly capacity: number
  readonly hold: number
  readonly speechHold: number
  readonly ttl: number
  readonly ambientOn: number
  readonly ambientOff: number

  /** Records in use, unordered. */
  private readonly used: CaptionLine[] = []
  /** Records free for reuse. */
  private readonly free: CaptionLine[] = []
  /** The array `lines()` fills and returns. */
  private readonly view: CaptionLine[] = []
  /** Ambient beds currently captioned, and those reading 'busy', by a numeric (kind, source) key. */
  private readonly ambientOnKeys = new Set<number>()
  private readonly ambientBusy = new Set<number>()
  private nextId = 1
  private readonly scratch: CaptionEvent = { kind: 'murmur', phase: 'start', source: 0, x: NaN, z: NaN, t: 0 }

  constructor(opts: CaptionOptions = {}) {
    const n = (v: number | undefined, d: number, min: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : d)
    this.maxLines = Math.floor(n(opts.maxLines, CAPTIONS.maxLines, 1))
    this.capacity = Math.max(this.maxLines, Math.floor(n(opts.capacity, CAPTIONS.capacity, 1)))
    this.hold = n(opts.hold, CAPTIONS.hold, 0)
    this.speechHold = n(opts.speechHold, CAPTIONS.speechHold, 0)
    this.ttl = n(opts.ttl, CAPTIONS.ttl, 0)
    this.ambientOn = n(opts.ambientOn, CAPTIONS.ambientOn, 0)
    this.ambientOff = Math.min(this.ambientOn, n(opts.ambientOff, CAPTIONS.ambientOff, 0))
  }

  /** Records held (live and holding), before expiry. */
  get size(): number { return this.used.length }

  /** Ids handed out so far; the next record takes `issued + 1`. */
  get issued(): number { return this.nextId - 1 }

  private find(kind: SoundKind, source: number): CaptionLine | null {
    const used = this.used
    for (let i = 0; i < used.length; i++) {
      const l = used[i]
      if (l.kind === kind && l.source === source) return l
    }
    return null
  }

  /** An ambient bed whose record left the track (expired or evicted) is captioned afresh when its level is next seen. */
  private forget(l: CaptionLine): void {
    if (l.kind !== 'murmur' && l.kind !== 'tyres') return
    const key = (l.kind === 'murmur' ? 0 : 1) * 65536 + l.source
    this.ambientOnKeys.delete(key)
    this.ambientBusy.delete(key)
  }

  /** Drops every record whose `until` has passed. */
  private expire(now: number): void {
    const used = this.used
    for (let i = used.length - 1; i >= 0; i--) {
      if (!(used[i].until > now)) {
        const l = used[i]
        used[i] = used[used.length - 1]
        used.pop()
        this.forget(l)
        this.free.push(l)
      }
    }
  }

  /** A record for a new sound: a pooled one, a fresh one under capacity, else the lowest-ranked record evicted. */
  private take(now: number): CaptionLine {
    const used = this.used
    if (used.length >= this.capacity) this.expire(now)
    let l = this.free.pop() ?? null
    if (l === null) {
      if (used.length < this.capacity) l = blank()
      else {
        let worst = 0
        for (let i = 1; i < used.length; i++) if (rank(used[i], used[worst]) > 0) worst = i
        l = used[worst]
        used[worst] = used[used.length - 1]
        used.pop()
        this.forget(l)
      }
    }
    used.push(l)
    return l
  }

  /**
   * Feeds one event. Returns true when a line was taken, retexted or ended; false when the event only refreshed a
   * continuing sound (its deadline and place) or was ignored (a change or stop for a sound the track does not hold,
   * or a malformed event). Never throws.
   */
  push(e: CaptionEvent, listener: ListenerPose): boolean {
    if (!e || typeof e.kind !== 'string' || !Object.hasOwn(PRIORITY, e.kind) || !Number.isFinite(e.t)) return false
    const source = Number.isFinite(e.source) ? e.source : 0
    const held = this.find(e.kind, source)
    const text = soundText(e)
    if (e.phase === 'stop') {
      if (held === null || !held.live) return false
      held.live = false
      held.until = e.t + (e.kind === 'speech' || e.kind === 'peer' ? this.speechHold : this.hold)
      if (text !== '') { held.text = text; held.since = e.t }
      this.place(held, e, listener)
      return true
    }
    if (e.phase === 'change' && held === null) return false
    let l = held
    let changed = false
    if (l === null) {
      l = this.take(e.t)
      l.id = this.nextId++
      l.kind = e.kind
      l.source = source
      l.text = text
      l.since = e.t
      l.live = true
      changed = true
    } else {
      if (!l.live) { l.live = true; changed = true }
      if (text !== '' && text !== l.text) { l.text = text; l.since = e.t; changed = true }
    }
    l.until = e.t + this.ttl
    this.place(l, e, listener)
    return changed
  }

  private place(l: CaptionLine, e: CaptionEvent, listener: ListenerPose): void {
    if (Number.isFinite(e.x) && Number.isFinite(e.z)) { l.x = e.x; l.z = e.z }
    bearInto(listener, l.x, l.z, l)
  }

  /**
   * An ambient bed's level (0..1) with hysteresis: the bed is captioned once its level reaches `ambientOn`, ends when
   * it falls under `ambientOff`, and a murmur's 'quiet'/'busy' word follows CAPTIONS.busy. Returns what push() did.
   */
  ambient(kind: 'murmur' | 'tyres', source: number, level: number, x: number, z: number, t: number, listener: ListenerPose): boolean {
    const key = (kind === 'murmur' ? 0 : 1) * 65536 + (Number.isFinite(source) ? source : 0)
    const on = this.ambientOnKeys.has(key)
    const lvl = Number.isFinite(level) ? level : 0
    const s = this.scratch
    s.kind = kind; s.source = source; s.x = x; s.z = z; s.t = t
    s.text = undefined; s.label = undefined; s.agent = undefined
    if (!on) {
      if (lvl < this.ambientOn) return false
      this.ambientOnKeys.add(key)
      const busy = lvl >= CAPTIONS.busy
      if (busy) this.ambientBusy.add(key); else this.ambientBusy.delete(key)
      s.phase = 'start'; s.detail = kind === 'murmur' ? (busy ? 'busy' : 'quiet') : undefined
      return this.push(s, listener)
    }
    if (lvl < this.ambientOff) {
      this.ambientOnKeys.delete(key)
      this.ambientBusy.delete(key)
      s.phase = 'stop'; s.detail = undefined
      return this.push(s, listener)
    }
    const busy = lvl >= CAPTIONS.busy
    if (kind === 'murmur' && busy !== this.ambientBusy.has(key)) {
      if (busy) this.ambientBusy.add(key); else this.ambientBusy.delete(key)
      s.phase = 'change'; s.detail = busy ? 'busy' : 'quiet'
      return this.push(s, listener)
    }
    s.phase = 'change'; s.detail = undefined
    return this.push(s, listener)
  }

  /**
   * The lines to show at `now`: expired records dropped, the rest ranked (speech, peer, ping, cue, walk signal,
   * cabin, engine, tyres, murmur; newest first within a kind), cut to `maxLines`. With a listener, every line's
   * bearing is recomputed from its last point first, so the arrows follow the head. The array is reused: copy it to
   * keep it.
   */
  lines(now: number, listener?: ListenerPose): readonly CaptionLine[] {
    this.expire(now)
    const view = this.view
    view.length = 0
    const used = this.used
    for (let i = 0; i < used.length; i++) {
      const l = used[i]
      if (listener) bearInto(listener, l.x, l.z, l)
      view.push(l)
    }
    view.sort(rank)
    if (view.length > this.maxLines) view.length = this.maxLines
    return view
  }

  /** Forgets everything (records return to the pool; ids keep counting). */
  clear(): void {
    const used = this.used
    while (used.length > 0) this.free.push(used.pop() as CaptionLine)
    this.view.length = 0
    this.ambientOnKeys.clear()
    this.ambientBusy.clear()
  }
}
