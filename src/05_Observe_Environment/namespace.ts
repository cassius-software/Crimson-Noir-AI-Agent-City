// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the city's unified namespace: every reading the HUD already receives each tick
 * (the SIPOC snapshot) and the physics counters beside it, structured as a publish/subscribe topic hierarchy in the
 * ISA-95 shape `Enterprise/JCS/Site/AgentCity/Area/{District}/Line/{Subsystem}/Cell/{EntityID}/{Tag}`. The bus
 * retains the last value of every topic with a sequence number and the tick it arrived on, answers wildcard filters
 * as MQTT spells them (`+` one level, `#` the rest), lists the levels below any prefix, calls subscribers inside the
 * publish, and folds every retained reading into one deterministic 32-bit head (FNV-1a over the sorted entries,
 * finished with the mixer the OS kernels use), so the console (`topic ...`) and the HUD can read any reading by name
 * and a later phase can put the same topics on a broker without renaming one. The bus is a model, in-page: nothing is
 * transmitted anywhere. It imports one type and no value, reaches no clock, no randomness and no host door, and
 * refuses rather than crashes: an invalid topic, a non-finite number or a publish past the topic limit returns null
 * and is counted.
 * What breaks if it is removed? No reading of the city has a name a filter can find, and the console's `topic` rows
 * and the namespace head have nothing to read.
 */
import type { SipocSnapshot } from './telemetry.ts'

/** The ISA-95 enterprise and site the city publishes under, and the root every topic starts with. */
export const UNS: Readonly<{ enterprise: 'JCS'; site: 'AgentCity'; root: 'Enterprise/JCS/Site/AgentCity' }> = Object.freeze({
  enterprise: 'JCS',
  site: 'AgentCity',
  root: 'Enterprise/JCS/Site/AgentCity',
} as const)

/** Distinct topics a bus retains by default; a publish to a new topic past it is refused. */
export const TOPIC_LIMIT = 4096

/** The longest segment a name becomes, the longest topic and the deepest topic the bus accepts, and the vehicle cap. */
const SEGMENT_CHARS = 32
const TOPIC_CHARS = 256
const TOPIC_LEVELS = 16
const VEHICLE_CAP = 64

const SLASH = 0x2f
const PLUS = 0x2b
const HASH = 0x23

export type TopicValue = number | string | boolean

/** One retained reading: the topic, its last value, the bus-wide sequence number of that publish, and its tick. */
export interface Retained { readonly topic: string; readonly value: TopicValue; readonly seq: number; readonly tick: number }

/** The physics counters the engine has beside the snapshot (terminal/bridge.ts PhysicsCounters, declared here without the import). */
export interface PhysicsReadings { stepMs: number; steps: number; bodies: number; colliders: number; ccd: number }

/** 'Financial District' -> 'FinancialDistrict': keeps [A-Za-z0-9_-], drops the rest; '' -> 'Unknown'; at most 32 chars. */
export function segment(text: string): string {
  const kept = text.replace(/[^A-Za-z0-9_-]/g, '')
  if (kept.length === 0) return 'Unknown'
  return kept.length > SEGMENT_CHARS ? kept.slice(0, SEGMENT_CHARS) : kept
}

/** `${UNS.root}/Area/${area}/Line/${line}/Cell/${cell}` + (tag ? `/${tag}` : ''), every part through segment(). */
export function topic(area: string, line: string, cell: string, tag?: string): string {
  const base = `${UNS.root}/Area/${segment(area)}/Line/${segment(line)}/Cell/${segment(cell)}`
  return tag ? `${base}/${segment(tag)}` : base
}

/** True when the filter level [from, to) is exactly the one character `code`. */
const isWild = (filter: string, from: number, to: number, code: number): boolean => to - from === 1 && filter.charCodeAt(from) === code

/**
 * '+' matches exactly one level, '#' (only as the last level) matches the rest (zero or more levels); otherwise the
 * levels must be equal. Written over indices so a publish fanning out to its subscribers allocates nothing.
 */
export function matches(filter: string, topic: string): boolean {
  const fn = filter.length
  const tn = topic.length
  let fi = 0
  // One past the topic's end marks "the topic has no level left" (a filter level may still be '#').
  let ti = 0
  for (;;) {
    const fSlash = filter.indexOf('/', fi)
    const fe = fSlash < 0 ? fn : fSlash
    const last = fe === fn
    if (isWild(filter, fi, fe, HASH)) return last
    if (ti > tn) return false
    const tSlash = topic.indexOf('/', ti)
    const te = tSlash < 0 ? tn : tSlash
    if (!isWild(filter, fi, fe, PLUS)) {
      if (fe - fi !== te - ti) return false
      for (let k = 0; k < fe - fi; k++) if (filter.charCodeAt(fi + k) !== topic.charCodeAt(ti + k)) return false
    }
    if (last) return te === tn
    fi = fe + 1
    ti = te + 1
  }
}

/** A publishable topic: non-empty levels, no '+' or '#', ASCII printable without spaces, at most 256 chars and 16 levels. */
export function isTopic(topic: string): boolean {
  const n = topic.length
  if (n === 0 || n > TOPIC_CHARS) return false
  let levels = 1
  let start = 0
  for (let i = 0; i < n; i++) {
    const c = topic.charCodeAt(i)
    if (c < 0x21 || c > 0x7e || c === PLUS || c === HASH) return false
    if (c === SLASH) {
      if (i === start) return false
      levels++
      if (levels > TOPIC_LEVELS) return false
      start = i + 1
    }
  }
  return start < n
}

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** The 32-bit mixer the OS kernels use (10_Network/telemetry.ts mix32, copied so this module imports no value). */
export function mix32(x0: number): number {
  let x = x0 >>> 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b) >>> 0
  x ^= x >>> 16
  return x >>> 0
}

/** FNV-1a continued from `h0` over the UTF-16 code units of `text`. */
function fnv1aText(h0: number, text: string): number {
  let h = h0 >>> 0
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), FNV_PRIME) >>> 0
  return h >>> 0
}

/** Plain string order, the order every listing uses. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const byTopic = (a: Retained, b: Retained): number => byText(a.topic, b.topic)

interface Subscriber { readonly filter: string; readonly fn: (r: Retained) => void }

/**
 * The retained topic store: last value per topic, a bus-wide sequence number per accepted publish, filters, children
 * and the head. Bounded by `limit` distinct topics; everything it refuses is counted, nothing throws.
 */
export class TopicBus {
  readonly limit: number
  private readonly retained = new Map<string, Retained>()
  private readonly subscribers: Subscriber[] = []
  private accepted = 0
  private declined = 0

  constructor(limit: number = TOPIC_LIMIT) {
    this.limit = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : TOPIC_LIMIT
  }

  /** Distinct topics retained. */
  get count(): number {
    return this.retained.size
  }

  /** Publishes accepted since construction (also the sequence number of the last one). */
  get publishes(): number {
    return this.accepted
  }

  /** Publishes refused since construction: an invalid topic, a non-finite number or a new topic past the limit. */
  get refused(): number {
    return this.declined
  }

  /**
   * Retains `value` under `topic` at `tick` and tells every matching subscriber, in subscription order, inside this
   * call. Null (and one more refused) for an invalid topic, a value that is not a finite number, a string or a
   * boolean (a caller outside the types), or a new topic once `limit` topics are held. A subscriber that throws stops
   * neither the others nor the publish.
   */
  publish(topic: string, value: TopicValue, tick: number): Retained | null {
    const kind = typeof value
    const ok = kind === 'string' || kind === 'boolean' || (kind === 'number' && Number.isFinite(value))
    if (!isTopic(topic) || !ok) {
      this.declined++
      return null
    }
    if (!this.retained.has(topic) && this.retained.size >= this.limit) {
      this.declined++
      return null
    }
    this.accepted++
    const entry: Retained = Object.freeze({ topic, value, seq: this.accepted, tick })
    this.retained.set(topic, entry)
    if (this.subscribers.length > 0) {
      // Over a copy, so a subscriber that unsubscribes (itself or another) inside the call skips nobody.
      const current = this.subscribers.slice()
      for (const s of current) {
        if (!matches(s.filter, topic)) continue
        try {
          s.fn(entry)
        } catch {
          // A subscriber's error is its own; the bus keeps its contract to the rest.
        }
      }
    }
    return entry
  }

  get(topic: string): Retained | null {
    return this.retained.get(topic) ?? null
  }

  /** Every retained entry whose topic matches `filter` ('#' = all), sorted by topic (plain string order). */
  list(filter: string = '#'): Retained[] {
    const out: Retained[] = []
    for (const entry of this.retained.values()) if (matches(filter, entry.topic)) out.push(entry)
    return out.sort(byTopic)
  }

  topics(filter: string = '#'): string[] {
    const out: string[] = []
    for (const t of this.retained.keys()) if (matches(filter, t)) out.push(t)
    return out.sort(byText)
  }

  /** Called with each publish whose topic matches `filter`; returns the unsubscribe (safe to call twice). */
  subscribe(filter: string, fn: (r: Retained) => void): () => void {
    const s: Subscriber = { filter, fn }
    this.subscribers.push(s)
    return () => {
      const i = this.subscribers.indexOf(s)
      if (i >= 0) this.subscribers.splice(i, 1)
    }
  }

  /** The levels below `prefix` (default the root; '' for the top): the next-level names with how many topics each holds, sorted. */
  children(prefix: string = UNS.root): { name: string; topics: number }[] {
    let base = prefix
    while (base.length > 0 && base.charCodeAt(base.length - 1) === SLASH) base = base.slice(0, -1)
    const counts = new Map<string, number>()
    for (const t of this.retained.keys()) {
      let from: number
      if (base.length === 0) from = 0
      else if (t.length > base.length && t.startsWith(base) && t.charCodeAt(base.length) === SLASH) from = base.length + 1
      else continue
      const slash = t.indexOf('/', from)
      const name = slash < 0 ? t.slice(from) : t.slice(from, slash)
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    const out: { name: string; topics: number }[] = []
    for (const [name, topics] of counts) out.push({ name, topics })
    return out.sort((a, b) => byText(a.name, b.name))
  }

  /**
   * A deterministic 32-bit digest of every retained (topic, value, seq): FNV-1a over the UTF-16 code units of
   * `${topic}=${String(value)}@${seq}` in sorted topic order, finished with mix32. The same publishes in the same
   * order give the same head on every machine; one changed value, or one changed sequence, changes it.
   */
  head(): number {
    const sorted = this.topics()
    let h = FNV_OFFSET
    for (const t of sorted) {
      const e = this.retained.get(t)!
      h = fnv1aText(h, `${t}=${String(e.value)}@${e.seq}`)
    }
    return mix32(h)
  }

  /** Drops every retained topic. Subscribers and the counters since construction stay. */
  clear(): void {
    this.retained.clear()
  }
}

/** The district's own name: the part of the HUD's district line before ' · ' or ' — '. */
function districtName(line: string): string {
  let end = line.length
  const dot = line.indexOf(' · ')
  if (dot >= 0 && dot < end) end = dot
  const dash = line.indexOf(' — ')
  if (dash >= 0 && dash < end) end = dash
  return line.slice(0, end)
}

/** A string reading with a name for the empty case. */
const named = (text: string, empty: string): string => (text === '' ? empty : text)

/** Publishes every reading of one snapshot (and the physics counters, when given); returns how many publishes were accepted. */
export function publishSnapshot(bus: TopicBus, s: SipocSnapshot, physics: PhysicsReadings | null, tick: number): number {
  const area = segment(districtName(s.customer.district))
  let accepted = 0
  const put = (line: string, cell: string, tag: string, value: TopicValue): void => {
    if (bus.publish(topic(area, line, cell, tag), value, tick) !== null) accepted++
  }
  const o = s.output
  const p = s.process
  const k = s.kernel
  const a = k.audit
  const q = s.quality
  const c = s.customer
  const sup = s.supplier
  const x = s.experience

  put('Frame', 'Page', 'fps', o.fps)
  put('Frame', 'Page', 'frameMs', o.frameMs)
  put('Frame', 'Page', 'p50Ms', o.p50Ms)
  put('Frame', 'Page', 'p95Ms', o.p95Ms)
  put('Frame', 'Page', 'cpuMs', o.cpuMs)
  put('Frame', 'Page', 'gpuRenderMs', o.gpuRenderMs)
  put('Frame', 'Page', 'gpuComputeMs', o.gpuComputeMs)
  put('Frame', 'Page', 'physicsMs', o.physicsMs)
  put('Frame', 'Page', 'rapierMs', o.rapierMs)
  put('Frame', 'Page', 'rendering', o.rendering ?? true)
  put('Frame', 'Page', 'ghost', o.ghost ?? false)
  put('Frame', 'Page', 'rain', o.matrix === true) // rain mode (01_Initialize_World/matrixMode.ts) is on

  if (physics !== null) {
    put('Physics', 'Realm', 'stepMs', physics.stepMs)
    put('Physics', 'Realm', 'steps', physics.steps)
    put('Physics', 'Realm', 'bodies', physics.bodies)
    put('Physics', 'Realm', 'colliders', physics.colliders)
    put('Physics', 'Realm', 'ccd', physics.ccd)
  }

  put('Crowd', 'Population', 'pedestrians', p.pedestrians)
  put('Crowd', 'Population', 'drawnNear', p.drawnNear)
  put('Crowd', 'Population', 'drawnFar', p.drawnFar)
  put('Crowd', 'Population', 'waiting', p.waiting)
  put('Crowd', 'Population', 'crossing', p.crossing)
  put('Crowd', 'Population', 'yielding', p.yielding)
  put('Crowd', 'Population', 'safetyNudges', p.safetyNudges)
  if (p.working !== undefined) put('Crowd', 'Population', 'working', p.working)
  if (typeof p.sensingAgeMs === 'number') put('Crowd', 'Population', 'sensingAgeMs', p.sensingAgeMs)
  if (p.sensingLagMs !== undefined) put('Crowd', 'Population', 'sensingLagMs', p.sensingLagMs)

  put('Traffic', 'Fleet', 'vehicles', p.vehicles)
  put('Traffic', 'Signals', 'ew', c.signalEW)
  put('Traffic', 'Signals', 'ns', c.signalNS)
  put('Traffic', 'Signals', 'remaining', c.signalRemaining)
  const cars = Math.min(s.map.length, VEHICLE_CAP)
  for (let i = 0; i < cars; i++) {
    const car = s.map[i]
    const cell = `Vehicle${String(i).padStart(3, '0')}`
    put('Traffic', cell, 'x', car.x)
    put('Traffic', cell, 'z', car.z)
    put('Traffic', cell, 'heading', car.heading)
    put('Traffic', cell, 'player', car.player)
  }

  put('Kernel', 'Laws', 'law1', k.law1)
  put('Kernel', 'Laws', 'law2', k.law2)
  put('Kernel', 'Laws', 'law3', k.law3)
  put('Kernel', 'Laws', 'sensorFlips', k.sensorFlips)
  put('Kernel', 'Laws', 'shielded', k.shielded)
  put('Kernel', 'Laws', 'last', named(k.last, 'none'))
  put('Kernel', 'Audit', 'ticks', a.ticks)
  put('Kernel', 'Audit', 'perimeterBreaches', a.perimeterBreaches)
  put('Kernel', 'Audit', 'velocityCaps', a.velocityCaps)
  put('Kernel', 'Audit', 'closest', Number.isFinite(a.closest) ? a.closest : 'none')
  put('Kernel', 'Audit', 'panic', a.panic ?? 'none')

  put('Quality', 'Governor', 'tier', q.tier)
  put('Quality', 'Governor', 'label', q.label)
  put('Quality', 'Governor', 'auto', q.auto)
  put('Quality', 'Governor', 'renderScale', q.renderScale)
  put('Quality', 'Governor', 'targetMs', q.targetMs)
  if (q.lite !== undefined) put('Quality', 'Governor', 'lite', q.lite)
  if (q.held !== undefined) put('Quality', 'Governor', 'held', q.held)

  put('Clock', 'Sun', 'clock', c.clock)
  put('Clock', 'Sun', 'daylight', c.daylight)

  put('Avatar', 'Player', 'x', c.x)
  put('Avatar', 'Player', 'z', c.z)
  put('Avatar', 'Player', 'heading', c.heading)
  put('Avatar', 'Player', 'speedKmh', c.speedKmh)
  put('Avatar', 'Player', 'gear', c.gear)
  put('Avatar', 'Player', 'mode', s.input.mode)
  put('Avatar', 'Player', 'nearVehicle', s.input.nearVehicle)
  put('Avatar', 'Player', 'name', named(c.name, 'anonymous'))

  put('Hardware', 'Bus', 'device', sup.device)
  put('Hardware', 'Bus', 'hal', named(sup.hal, 'none'))
  put('Hardware', 'Bus', 'glyphs', sup.glyphs)
  put('Hardware', 'Bus', 'pointerLocked', sup.pointerLocked)
  put('Hardware', 'Bus', 'touch', sup.touch)
  put('Hardware', 'Bus', 'recording', sup.recording.active)
  put('Hardware', 'Bus', 'xr', sup.xr.state)

  if (o.net !== undefined) {
    put('Network', 'Session', 'state', o.net.state)
    put('Network', 'Session', 'peers', o.net.peers)
    put('Network', 'Session', 'dropped', o.net.dropped)
  }

  put('Experience', 'Session', 'sessionSeconds', x.sessionSeconds)
  put('Experience', 'Session', 'longFrames', x.longFrames)
  put('Experience', 'Session', 'distanceWalked', x.distanceWalked)
  put('Experience', 'Session', 'distanceDriven', x.distanceDriven)

  // The bus's own readings go last, each with the count at that moment.
  put('Namespace', 'Bus', 'topics', bus.count)
  put('Namespace', 'Bus', 'publishes', bus.publishes)
  return accepted
}

/** Any character the console cannot print (outside 0x20..0x7e) reads as '?'. */
function ascii(text: string): string {
  let clean = true
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || c > 0x7e) { clean = false; break }
  }
  return clean ? text : text.replace(/[^\x20-\x7e]/g, '?')
}

/**
 * A value as the console shows it: integers plain, other numbers to 3 decimals, booleans on/off, strings as they are;
 * anything else (a hand-built entry outside the types) as '-', so a row never throws.
 */
function show(value: TopicValue): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '-'
    return Number.isInteger(value) ? String(value) : value.toFixed(3)
  }
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  return typeof value === 'string' ? ascii(value) : '-'
}

/** The topic with the root replaced by '~' (a topic off the root is shown whole). */
const short = (topic: string): string => (topic.startsWith(UNS.root) ? `~${topic.slice(UNS.root.length)}` : topic)

/** The console rows for entries: the shortened topic, two spaces, the value; ASCII only. */
export function topicLines(entries: readonly Retained[]): string[] {
  const out: string[] = []
  for (const e of entries) out.push(`${ascii(short(e.topic))}  ${show(e.value)}`)
  return out
}

/** `children` as rows: `Area/              12 topics` style, the name column padded to 16, the count right-aligned to 5. */
export function childLines(bus: TopicBus, prefix?: string): string[] {
  const rows = bus.children(prefix)
  let width = 16
  for (const r of rows) width = Math.max(width, r.name.length + 3)
  const out: string[] = []
  for (const r of rows) out.push(`${ascii(`${r.name}/`).padEnd(width)}${String(r.topics).padStart(5)} topics`)
  return out
}
