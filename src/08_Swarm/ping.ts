// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the operator's non-verbal ping: a point in the world marked by looking at it, in
 * two layers. The first is view-only and lives on the page: `pickPing` resolves the head's look ray (head.ts
 * aimRay) against what the page already holds — the pedestrians' capsules in the crowd's render frame, the cars'
 * chassis boxes in the pose buffer, the lamps, trees and signal poles of the city's furniture, and the ground — and
 * names the nearest thing met within PING_RANGE; `PingBoard` keeps a bounded, rate-limited list of such pings, each
 * with a kind (go, look, gather, wait) and a lifetime, as plain data the HUD and the minimap draw. The second layer
 * is a request: `rallyPlan` turns the newest walk ping into the plain-data request for one Active (tethered)
 * recruit to walk to a pinged sidewalk point near the operator, or says why not. Nothing here reaches a pedestrian:
 * the request is handed to the recruiter, and the physics realm re-validates it on its own readings before any
 * summons slot moves (the air gap). Pure: no clock of its own (the caller stamps `now`), no randomness, no I/O.
 * What breaks if it is removed? The operator could only command the swarm by speaking or typing; a marked point
 * would have no record to draw, and a ping could ask a recruit into the road or across the tether's reach.
 */
import { POLES, type Furniture } from '../01_Initialize_World/city.ts'
import { INTERVIEW_DISTANCE, onRoad, RELEASE_DISTANCE, sidewalkPath } from '../03_Spawn_Agents/skills.ts'
import { chassisBox } from '../07_Execute_Actions/car.ts'
import type { AimRay } from '../07_Execute_Actions/head.ts'
import { PERSON, POSE, type RecruitView } from '../07_Execute_Actions/simProtocol.ts'

/** Farthest a ping reaches along the look ray, m. */
export const PING_RANGE = 60
/**
 * Farthest from the operator a recruit may be sent, m: under RELEASE_DISTANCE less the interview standoff and a
 * margin, so a recruit standing at the pinged point is still within the tether, which stays measured from the
 * operator (skills.ts). RELEASE_DISTANCE − INTERVIEW_DISTANCE − 1 = 9.5 today; 9 keeps half a metre more.
 */
export const RALLY_RANGE = 9

/** What a ping means. `go` and `gather` ask people to walk; `look` and `wait` are marks only. */
export type PingKind = 'go' | 'look' | 'gather' | 'wait'
export const PING_KINDS: readonly PingKind[] = Object.freeze(['go', 'look', 'gather', 'wait'])
/** How long a ping of each kind stays on the board, s. */
export const PING_TTL_S: Readonly<Record<PingKind, number>> = Object.freeze({ go: 10, look: 6, gather: 15, wait: 10 })
/** The least time between two pings, s: a held key or a bouncing button places one, not a stream. */
export const PING_INTERVAL_S = 0.5
/** Pings kept at once; the oldest is dropped for a newer one. */
export const PING_MAX = 8
/** A word per kind, for the HUD and the captions. */
export const PING_WORDS: Readonly<Record<PingKind, string>> = Object.freeze({ go: 'go there', look: 'look there', gather: 'gather there', wait: 'wait there' })

/** What the look ray met: the ground, a pedestrian, a car's chassis, or a pole (lamp, tree or signal). */
export type PickKind = 'point' | 'person' | 'car' | 'pole'

/** One resolved look: what was met, its index (pedestrian row, car index, pole index; −1 for the ground) and where. */
export interface Pick {
  kind: PickKind
  index: number
  x: number
  y: number
  z: number
  /** Metres along the ray from the eye. */
  distance: number
}

/** What the page already holds, as plain numbers: nothing crosses from the physics realm for a ping. */
export interface PingWorld {
  /** The crowd's render frame (pos x, y, z, heading per pedestrian first, crowdCompute.ts RENDER_FLOATS), or none. */
  frame: Float32Array | null
  /** Pedestrian rows to consider (row 0 is the player's own body and is never picked). */
  agents: number
  /** The fleet's poses (simProtocol POSE stride) and which cars are SUVs (the chassis box differs). */
  poses: Float32Array
  suv: readonly boolean[]
  /** The city's lamps, trees and signal poles, or none. */
  furniture: Furniture | null
}

/** A ping on the board. */
export interface Ping {
  /** 1, 2, 3… in placing order; never reused by one board. */
  readonly id: number
  readonly kind: PingKind
  readonly pick: PickKind
  readonly index: number
  readonly x: number
  readonly y: number
  readonly z: number
  /** When it was placed (the caller's seconds) and when it expires. */
  readonly at: number
  readonly until: number
}

/** A ping as the HUD and the minimap draw it: plain data, age and time left in seconds. */
export interface PingMark {
  readonly id: number
  readonly kind: PingKind
  readonly pick: PickKind
  readonly index: number
  readonly x: number
  readonly z: number
  readonly age: number
  readonly left: number
}

/** The plain-data request the recruiter sends the physics realm: this recruit walks to (x, z). */
export interface RallyRequest { readonly agent: number; readonly x: number; readonly z: number }
/** A request, or null with the reason there is none. */
export type RallyPlan = { readonly request: RallyRequest; readonly reason: null } | { readonly request: null; readonly reason: string }

/** A pedestrian's hidden rows (folded far below the street, as contact.ts skips them) are not people to meet. */
const HIDDEN_Y = -50
/** Below this a direction has no horizontal part: straight up or down. */
const EPS = 1e-9

/** Metres along the ray to a sphere at (cx, cy, cz) of radius r, or −1 when the ray misses or starts inside it. */
function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, r: number): number {
  const px = ox - cx, py = oy - cy, pz = oz - cz
  const b = px * dx + py * dy + pz * dz
  const c = px * px + py * py + pz * pz - r * r
  if (c < 0) return -1
  const disc = b * b - c
  if (disc < 0) return -1
  const t = -b - Math.sqrt(disc)
  return t >= 0 ? t : -1
}

/**
 * Metres along the (unit) ray to an upright capsule: radius r about the vertical segment from (cx, y0, cz) to
 * (cx, y1, cz), the caps included (so the body spans y0 − r to y1 + r). −1 when missed or when the eye is inside it.
 */
function rayCapsule(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cz: number, y0: number, y1: number, r: number): number {
  const px = ox - cx, pz = oz - cz
  const a = dx * dx + dz * dz
  const c = px * px + pz * pz - r * r
  if (a > EPS) {
    const b = px * dx + pz * dz
    const disc = b * b - a * c
    if (disc < 0) return -1
    const t = (-b - Math.sqrt(disc)) / a
    if (t < 0) return -1
    const y = oy + t * dy
    if (y >= y0 && y <= y1) return t
    return y < y0 ? raySphere(ox, oy, oz, dx, dy, dz, cx, y0, cz, r) : raySphere(ox, oy, oz, dx, dy, dz, cx, y1, cz, r)
  }
  // Straight up or down: only a cap can be met, and only from outside the body.
  if (c > 0) return -1
  return dy < 0 ? raySphere(ox, oy, oz, dx, dy, dz, cx, y1, cz, r) : raySphere(ox, oy, oz, dx, dy, dz, cx, y0, cz, r)
}

/**
 * Metres along the (unit) ray to a box centred at (cx, cy, cz), yawed by `heading` (forward (sin h, cos h), as
 * contact.ts boxGap reads a chassis), of half extents hx along, hy up, hz across. −1 when missed or started inside.
 */
function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, heading: number, hx: number, hy: number, hz: number): number {
  const fx = Math.sin(heading), fz = Math.cos(heading)
  const rx = ox - cx, rz = oz - cz
  // Into box space: along, up, across; then one slab per axis.
  tNear = 0; tFar = Infinity
  if (!slab(rx * fx + rz * fz, dx * fx + dz * fz, hx)) return -1
  if (!slab(oy - cy, dy, hy)) return -1
  if (!slab(rx * fz - rz * fx, dx * fz - dz * fx, hz)) return -1
  // tNear 0 means the eye is inside the box: nothing to point at.
  return tNear > 0 ? tNear : -1
}

/** The slab test's running interval (module scratch, so rayBox allocates nothing). */
let tNear = 0, tFar = Infinity
/** Narrows [tNear, tFar] to the slab |o + t·d| ≤ h; false once the interval is empty. */
function slab(o: number, d: number, h: number): boolean {
  if (Math.abs(d) < EPS) return o >= -h && o <= h
  let t0 = (-h - o) / d, t1 = (h - o) / d
  if (t0 > t1) { const s = t0; t0 = t1; t1 = s }
  if (t0 > tNear) tNear = t0
  if (t1 < tFar) tFar = t1
  return tNear <= tFar
}

/** The nearest pole of `list` the ray meets closer than `best`: its index in the list, or −1; its distance in `poleT`. */
let poleT = 0
function nearestPole(list: readonly (readonly number[])[], pole: { readonly height: number; readonly radius: number }, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, best: number): number {
  const reach = best + pole.radius
  let hit = -1
  poleT = best
  for (let i = 0; i < list.length; i++) {
    const x = list[i][0], z = list[i][1]
    if (Math.abs(x - ox) > reach || Math.abs(z - oz) > reach) continue
    const t = rayCapsule(ox, oy, oz, dx, dy, dz, x, z, pole.radius, pole.height - pole.radius, pole.radius)
    if (t >= 0 && t < poleT) { poleT = t; hit = i }
  }
  return hit
}

/**
 * What the look ray meets first within PING_RANGE, written into `out`: a pedestrian's capsule (PERSON, feet at
 * the frame's y), a car's chassis box (car.ts chassisBox at its pose), a pole's cylinder (city.ts POLES, as a
 * capsule a pole's radius wide), else the ground plane y = 0 as a 'point'. The nearest wins. False, and `out`
 * untouched, when nothing is within range or the ray is not a number. Allocation-free; row 0 (the player's own
 * body) and hidden rows are never picked. Pole indices count lamps, then trees, then signals, in furniture order.
 */
export function pickPing(ray: AimRay, world: PingWorld, out: Pick, range: number = PING_RANGE): boolean {
  const { ox, oy, oz } = ray
  let { dx, dy, dz } = ray
  if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz) || !Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return false
  const len = Math.hypot(dx, dy, dz)
  if (!(len > EPS) || !(range > 0)) return false
  dx /= len; dy /= len; dz /= len
  let best = range, kind: PickKind = 'point', index = -1

  // The ground: the fallback everything else must beat.
  if (dy < 0) {
    const t = -oy / dy
    if (t >= 0 && t < best) { best = t; kind = 'point'; index = -1 }
  }

  const { frame, poses, suv, furniture } = world
  if (frame) {
    const n = Math.min(world.agents, Math.floor(frame.length / 4))
    const reach = best + PERSON.radius
    for (let i = 1; i < n; i++) {
      const o = 4 * i
      const fy = frame[o + 1]
      if (!(fy > HIDDEN_Y)) continue
      const x = frame[o], z = frame[o + 2]
      if (Math.abs(x - ox) > reach || Math.abs(z - oz) > reach) continue
      const t = rayCapsule(ox, oy, oz, dx, dy, dz, x, z, fy + PERSON.radius, fy + PERSON.radius + 2 * PERSON.halfHeight, PERSON.radius)
      if (t >= 0 && t < best) { best = t; kind = 'person'; index = i }
    }
  }
  for (let i = 0; i < suv.length; i++) {
    const o = i * POSE.stride
    if (o + POSE.stride > poses.length) break
    const cx = poses[o + POSE.x], cy = poses[o + POSE.y], cz = poses[o + POSE.z], h = poses[o + POSE.heading]
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz) || !Number.isFinite(h)) continue
    const c = chassisBox(suv[i])
    if (Math.abs(cx - ox) > best + c.hx || Math.abs(cz - oz) > best + c.hx) continue
    const t = rayBox(ox, oy, oz, dx, dy, dz, cx, cy + c.y, cz, h, c.hx, c.hy, c.hz)
    if (t >= 0 && t < best) { best = t; kind = 'car'; index = i }
  }
  if (furniture) {
    const { lamps, trees, signals } = furniture
    let i = nearestPole(lamps, POLES.lamp, ox, oy, oz, dx, dy, dz, best)
    if (i >= 0) { best = poleT; kind = 'pole'; index = i }
    i = nearestPole(trees, POLES.tree, ox, oy, oz, dx, dy, dz, best)
    if (i >= 0) { best = poleT; kind = 'pole'; index = lamps.length + i }
    i = nearestPole(signals, POLES.signal, ox, oy, oz, dx, dy, dz, best)
    if (i >= 0) { best = poleT; kind = 'pole'; index = lamps.length + trees.length + i }
  }

  if (best >= range) return false
  out.kind = kind
  out.index = index
  out.x = ox + dx * best
  out.y = oy + dy * best
  out.z = oz + dz * best
  out.distance = best
  return true
}

/**
 * The pings standing: at most PING_MAX, each alive until its kind's lifetime runs out, one placed per
 * PING_INTERVAL_S at most. No clock of its own: every call takes the caller's seconds.
 */
export class PingBoard {
  #pings: Ping[] = []
  #nextId = 1
  #lastAt = NaN

  /** Pings on the board, expired ones included until the next call that takes `now`. */
  get size(): number {
    return this.#pings.length
  }

  /**
   * Places a ping of `kind` at what the look met, at `now`. Null (and nothing placed) when another was placed
   * less than PING_INTERVAL_S ago, when the kind is unknown, or when a number is not one. The oldest ping is
   * dropped once PING_MAX stand.
   */
  place(kind: PingKind, pick: Pick, now: number): Ping | null {
    if (!PING_KINDS.includes(kind) || !Number.isFinite(now)) return null
    if (!Number.isFinite(pick.x) || !Number.isFinite(pick.y) || !Number.isFinite(pick.z) || !Number.isInteger(pick.index)) return null
    if (Number.isFinite(this.#lastAt) && now >= this.#lastAt && now - this.#lastAt < PING_INTERVAL_S) return null
    this.prune(now)
    const ping: Ping = Object.freeze({
      id: this.#nextId++, kind, pick: pick.kind, index: pick.index, x: pick.x, y: pick.y, z: pick.z, at: now, until: now + PING_TTL_S[kind],
    })
    this.#pings.push(ping)
    while (this.#pings.length > PING_MAX) this.#pings.shift()
    this.#lastAt = now
    return ping
  }

  /** Drops every ping whose lifetime has run out at `now`; returns how many were dropped. */
  prune(now: number): number {
    if (!Number.isFinite(now)) return 0
    const before = this.#pings.length
    this.#pings = this.#pings.filter((p) => now < p.until)
    return before - this.#pings.length
  }

  /** The pings still standing at `now`, oldest first. */
  alive(now: number): readonly Ping[] {
    this.prune(now)
    return this.#pings
  }

  /** The newest ping standing at `now`, or null. */
  newest(now: number): Ping | null {
    const list = this.alive(now)
    return list.length ? list[list.length - 1] : null
  }

  /** Drops every ping; returns how many there were. */
  clear(): number {
    const n = this.#pings.length
    this.#pings = []
    return n
  }

  /** What the HUD and the minimap draw at `now`: plain data, oldest first. */
  snapshot(now: number): PingMark[] {
    return this.alive(now).map((p) => ({ id: p.id, kind: p.kind, pick: p.pick, index: p.index, x: p.x, z: p.z, age: now - p.at, left: p.until - now }))
  }
}

/** One ping as one ASCII line for the console and the captions: 'ping 3  go  person 12 at (312.4, 88.1)  4 s ago'. */
export function pingLine(p: Ping, now: number): string {
  const what = p.pick === 'point' ? 'point' : `${p.pick} ${p.index}`
  const age = Number.isFinite(now) ? Math.max(0, Math.round(now - p.at)) : 0
  return `ping ${p.id}  ${p.kind}  ${what} at (${p.x.toFixed(1)}, ${p.z.toFixed(1)})  ${age} s ago`
}

/**
 * The request for one Active recruit to walk to the newest walk ping (go or gather) standing at `now`, or null
 * with the reason. `agent` names the recruit; left out, the earliest-joined Active recruit is asked. A request is
 * only made for a point off the road, within RALLY_RANGE of the operator (so the tether, measured from the
 * operator, holds at the point), reachable from where the recruit stands without a carriageway when their
 * position is known; a car is never a place to stand. The physics realm re-checks all of it on its own readings.
 */
export function rallyPlan(board: PingBoard, recruits: readonly RecruitView[], operator: { x: number; z: number } | null, now: number, agent?: number): RallyPlan {
  if (!operator) return refused('rallying works on foot')
  if (!Number.isFinite(operator.x) || !Number.isFinite(operator.z)) return refused('the operator is nowhere')
  const ping = board.newest(now)
  if (!ping) return refused('nothing is pinged')
  if (ping.kind !== 'go' && ping.kind !== 'gather') return refused(`a ${ping.kind} ping asks nobody to walk`)
  if (ping.pick === 'car') return refused('a car is not a place to stand')
  const active = recruits.filter((r) => r.arrived)
  if (active.length === 0) return refused('nobody is tethered yet')
  let who: RecruitView
  if (agent === undefined) {
    who = active[0]
  } else {
    const found = active.find((r) => r.agent === agent)
    if (!found) return refused(recruits.some((r) => r.agent === agent) ? `agent ${agent} is still walking over` : `agent ${agent} is not tethered`)
    who = found
  }
  if (onRoad(ping.x, ping.z)) return refused('nobody is sent into the road')
  if (Math.hypot(ping.x - operator.x, ping.z - operator.z) > RALLY_RANGE) return refused(`too far to follow: within ${RALLY_RANGE} m of you`)
  if (Number.isFinite(who.x) && Number.isFinite(who.z) && !sidewalkPath(who.x, who.z, ping.x, ping.z)) return refused('no sidewalk from where they stand')
  return { request: Object.freeze({ agent: who.agent, x: ping.x, z: ping.z }), reason: null }
}

const refused = (reason: string): RallyPlan => ({ request: null, reason })

/** Pinned by ping.test.ts: RALLY_RANGE keeps a rallied recruit inside the tether with the interview standoff and a margin to spare. */
export const RALLY_MARGIN = RELEASE_DISTANCE - INTERVIEW_DISTANCE - RALLY_RANGE
