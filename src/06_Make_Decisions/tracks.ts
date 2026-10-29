// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the fixed track network: every non-player vehicle follows a closed spline
 * with an arc-length parameter, computed from the seed and the city grid alone. Cars get the clockwise,
 * right-hand-lane, right-turns-only boundary loops of 2 × 2-block cells (64 rings); because every
 * (segment, direction) belongs to at most one ring, no two rings share a point, nobody turns across an
 * oncoming lane, and no other ring's queue can block a ring's box (a ring's own driver holds at the line
 * without room to clear it: roomToClear). Trains get one elevated loop on a deck 9 m over
 * the median of two arterial streets, drones face-ring corridors at 40 and 46 m, planes one racetrack at
 * 400 m, and VTOLs two routes between rooftop pads (roofs of 24 to 60 m, chosen from the city's own boxes so
 * every leg and every descent is clear of every building): none of them ever reaches the street or the
 * sidewalk plane, so none needs the kernel. The module also holds the headway slots (where a fleet seats its
 * cars), the ring gaps a track follower reads for the cars of its own ring, the timetables of the scheduled
 * vehicles, and the guideway columns a renderer draws. It is pure: no physics handle, nothing loaded, and the
 * zero-jam invariants (tracks.test.ts INV-1..4) are proved on it in Node.
 * What breaks if it is removed? Cars fall back to the random street-hopping Driver (traffic.ts) and jams
 * become possible again; trains, drones, planes and VTOLs have nowhere to run.
 */
import { CITY, CITY_CENTER, type Box } from '../01_Initialize_World/city.ts'
import { TRAFFIC, type Axis } from '../02_Define_The_Rules/civic.ts'
import { createRng } from '../02_Define_The_Rules/degrees.ts'

export type Vec2 = readonly [number, number]
export type Turn = 'straight' | 'left' | 'right'
export type TrackKind = 'car' | 'train' | 'drone' | 'plane' | 'vtol'

/** A straight piece along `dir` (a unit axis vector) from (x0, z0). */
export interface Line {
  readonly kind: 'line'
  readonly s0: number
  readonly length: number
  readonly x0: number
  readonly z0: number
  readonly dx: number
  readonly dz: number
  readonly axis: Axis
  readonly dir: Vec2
}

/** A quadratic Bézier corner e → c → x with a look-up table of t at equal arc-length steps. */
export interface Corner {
  readonly kind: 'corner'
  readonly s0: number
  readonly length: number
  readonly e: Vec2
  readonly c: Vec2
  readonly x: Vec2
  /** LUT_SIZE entries: Bézier t at s = k · length / (LUT_SIZE − 1). */
  readonly lut: Float32Array
}

/** A circular arc: angle a0 + sweep · (local / length) about (cx, cz); positive sweep turns right. */
export interface Arc {
  readonly kind: 'arc'
  readonly s0: number
  readonly length: number
  readonly cx: number
  readonly cz: number
  readonly radius: number
  readonly a0: number
  readonly sweep: number
}

export type Piece = Line | Corner | Arc

/** A stop line a car track holds at: `s` is where the car's centre stands with its bumper on the line. */
export interface Stop { readonly s: number; readonly axis: Axis }

export interface Track {
  readonly id: number
  readonly kind: TrackKind
  /** Metres around the loop; every s is taken modulo this. */
  readonly length: number
  readonly pieces: readonly Piece[]
  /** Stop lines in order of s (car tracks only). */
  readonly stops: readonly Stop[]
  /** Station platforms in order of s (train tracks only): the train's centre stops here. A VTOL route's pads, likewise. */
  readonly stations: readonly number[]
  /** Per station of a VTOL route, the roof its pad is set on, m over the street plane (empty for every other kind). */
  readonly pads: readonly number[]
  readonly speedLimit: number
  readonly cornerSpeed: number
  /** Metres per headway slot. */
  readonly slot: number
  /** Height of the track (the street plane for cars, the deck or the corridor altitude otherwise; a VTOL route's cruise). */
  readonly y: number
}

/** A rooftop a VTOL route calls at: the roof's centre and its height, m over the street plane. */
export interface Pad { readonly x: number; readonly z: number; readonly y: number }

export interface TrackNetwork { readonly seed: number; readonly tracks: readonly Track[] }

export interface TrackPose {
  x: number
  y: number
  z: number
  /** atan2(tangentX, tangentZ): the convention of Driver.lanePose. */
  heading: number
  tangentX: number
  tangentZ: number
}

/** Bézier entry distance from the intersection centre and the car's half-length: traffic.ts:25-26. */
const ENTRY = 7.5
const HALF_LENGTH = 2.3
/** Arc-length look-up entries per corner. */
const LUT_SIZE = 33
/** Newton steps of projectOnto are clamped to this many metres; a hint further off falls back to the global search. */
const NEWTON_STEP = 3
/** projectOnto's hint is trusted only within this lateral distance of the track. */
const HINT_LATERAL = 5
/**
 * Metres past a stop line at which a car's rear bumper has left the intersection box: the stop stays the
 * current one until then, so a car committed to a red that creeps over the line keeps holding (traffic.ts
 * keeps its street's stop until the turn), and one that passed on green is never re-committed inside the box.
 */
const STOP_CLEAR = TRAFFIC.stopLine + CITY.roadHalf + 2 * HALF_LENGTH
/** Bumper gap at which a following driver stands still: traffic.ts:207. */
const FOLLOW_STOP = 3

export const TRACKS = Object.freeze({
  car: Object.freeze({
    /** Free road a seated follower has ahead at spawn (traffic.ts follows no closer than 3 m). */
    headway: 8,
    /** Metres per slot: one car plus its headway. */
    slot: 2 * HALF_LENGTH + 8,
    /** Blocks per side of a ring's cell. */
    faceBlocks: 2,
    /** Clearance envelope over a car track: the tallest vehicle roof. */
    height: 2,
  }),
  train: Object.freeze({
    /** Deck height over the street plane, m. */
    deck: 9,
    speed: 12,
    /** One set's overall length; a renderer draws it as rigid cars no longer than 8 m each. */
    length: 24,
    sets: 3,
    /** Seconds a set stands at a station. */
    dwell: 15,
    /** The two arterial lines (both axes) the loop runs over. */
    corridor: [4, 12] as const,
    /** Corner arc radius, m. */
    radius: 15,
    /** Half-width of a set's section; the body stands from the deck to deck + height. */
    halfWidth: 1.5,
    height: 4,
    /**
     * Guideway columns: this far along each block from its intersection, on both curbs. Clear of the lamps
     * (10, 30 m) and the trees (20 m); 8 m from a corner keeps a column 2.5 m from a turning car's path, as
     * far as a lamp stands from a straight lane (5 m would leave 1.9 m).
     */
    columns: [8, 16, 24, 32] as const,
    columnRadius: 0.3,
    /** Least spacing between sets the timetable keeps: a set plus a margin. */
    spacing: 24 + 50,
  }),
  drone: Object.freeze({
    /** Clockwise corridors at the first altitude, counter-clockwise at the second. */
    altitude: [40, 46] as const,
    speed: 8,
    headway: 20,
    /** Blocks per side of a corridor's cell. */
    faceBlocks: 4,
    /** Right-hand corridor lane, m off the centreline, so opposite corridors are 4 m apart. */
    laneOffset: 2,
    halfSize: 0.5,
  }),
  plane: Object.freeze({
    altitude: 400,
    speed: 60,
    headway: 500,
    count: 3,
    /** Racetrack: straights of 2 · halfSize about the city centre, joined by semicircles of `fillet`. */
    halfSize: 600,
    fillet: 400,
    halfLength: 20,
    /** Half the envelope's height: the fin's top over the fuselage's centre. */
    halfHeight: 6,
  }),
  vtol: Object.freeze({
    /**
     * Cruise altitude of each route between its pads, m: the inner route under the outer, both well over the drones'
     * upper band (46 m plus half a metre) and under the planes, so a leg of one may cross a leg of the other.
     */
    cruise: [75, 85] as const,
    /** The lowest roof a pad is set on, m: the kind's Ring-0 floor (ring0.ts CRAFT), under which no VTOL is ever scheduled. */
    floor: 24,
    /** The highest roof a pad is set on, m: a craft arriving over one keeps at least `clearance` under its cruise. */
    ceiling: 60,
    /** Least height of the envelope's bottom at cruise over any box a leg crosses, m. */
    clearance: 8,
    speed: 9,
    /** Mean vertical speed, m/s, descending onto a pad and climbing off it (eased at both ends: the peak is 1.5 times it). */
    climb: 4,
    /** Seconds sat on a pad. */
    dwell: 10,
    /** Height of the body's centre over the roof when sat, m: the envelope's bottom rests just over the pad. */
    hover: 1.7,
    /** The envelope: half-size across and along, half-height. */
    halfSize: 3,
    halfHeight: 1.5,
    /** Least half-extent of a roof that takes a pad, m: the envelope and a margin lie within it. */
    padHalf: 4,
    /** Routes, pads per route and craft per route. */
    routes: 2,
    pads: 4,
    craft: 2,
    /** Least horizontal distance between a leg and any pad that is not one of its ends, and between two pads, m. */
    apart: 8,
    /** Shortest leg, m. */
    legMin: 40,
  }),
})

const right = (d: Vec2): Vec2 => [-d[1], d[0]]
const left = (d: Vec2): Vec2 => [d[1], -d[0]]
const same = (a: Vec2, b: Vec2): boolean => a[0] === b[0] && a[1] === b[1]
const axisOf = (dir: Vec2): Axis => (dir[0] !== 0 ? 'ew' : 'ns')

/**
 * The exact control points of Driver.bezier (traffic.ts:115-127): entry `e` ENTRY before the intersection
 * `to` on the approach lane, exit `x` ENTRY past it on the exit lane, control `c` at the corner of the two
 * lane lines (right), across it (left) or the midpoint (straight). A negative laneOffset is the left-hand lane.
 */
export function turnBezier(to: Vec2, dir: Vec2, exitDir: Vec2, turn: Turn, laneOffset: number = TRAFFIC.laneOffset): { e: Vec2; c: Vec2; x: Vec2 } {
  const B: Vec2 = [to[0] * CITY.pitch, to[1] * CITY.pitch]
  const r1 = right(dir), r2 = right(exitDir), L = laneOffset
  const e: Vec2 = [B[0] - dir[0] * ENTRY + r1[0] * L, B[1] - dir[1] * ENTRY + r1[1] * L]
  const x: Vec2 = [B[0] + exitDir[0] * ENTRY + r2[0] * L, B[1] + exitDir[1] * ENTRY + r2[1] * L]
  const c: Vec2 = turn === 'straight'
    ? [(e[0] + x[0]) / 2, (e[1] + x[1]) / 2]
    : turn === 'right'
      ? [B[0] + r1[0] * L - dir[0] * L, B[1] + r1[1] * L - dir[1] * L]
      : [B[0] + r1[0] * L + dir[0] * L, B[1] + r1[1] * L + dir[1] * L]
  return { e, c, x }
}

function bezierPoint(e: Vec2, c: Vec2, x: Vec2, t: number): Vec2 {
  const u = 1 - t
  return [u * u * e[0] + 2 * u * t * c[0] + t * t * x[0], u * u * e[1] + 2 * u * t * c[1] + t * t * x[1]]
}

function linePiece(s0: number, x0: number, z0: number, dir: Vec2, length: number): Line {
  return Object.freeze({ kind: 'line' as const, s0, length, x0, z0, dx: dir[0], dz: dir[1], axis: axisOf(dir), dir })
}

/** A corner with its arc-length table: 256 chords integrate the length, then t is read at equal steps of s. */
function cornerPiece(s0: number, e: Vec2, c: Vec2, x: Vec2): Corner {
  const N = 256
  const cum = new Float64Array(N + 1)
  let [px, pz] = e
  for (let i = 1; i <= N; i++) {
    const [qx, qz] = bezierPoint(e, c, x, i / N)
    cum[i] = cum[i - 1] + Math.hypot(qx - px, qz - pz)
    px = qx
    pz = qz
  }
  const length = cum[N]
  const lut = new Float32Array(LUT_SIZE)
  let j = 0
  for (let k = 0; k < LUT_SIZE; k++) {
    const goal = (k / (LUT_SIZE - 1)) * length
    while (j < N - 1 && cum[j + 1] < goal) j++
    const span = cum[j + 1] - cum[j]
    lut[k] = (j + (span > 0 ? (goal - cum[j]) / span : 0)) / N
  }
  lut[LUT_SIZE - 1] = 1
  return Object.freeze({ kind: 'corner' as const, s0, length, e, c, x, lut })
}

function arcPiece(s0: number, cx: number, cz: number, radius: number, a0: number, sweep: number): Arc {
  return Object.freeze({ kind: 'arc' as const, s0, length: radius * Math.abs(sweep), cx, cz, radius, a0, sweep })
}

function makeTrack(id: number, kind: TrackKind, pieces: Piece[], stops: Stop[], stations: number[], y: number, pads: number[] = []): Track {
  const last = pieces[pieces.length - 1]
  const length = last.s0 + last.length
  const limits = kind === 'car'
    ? { speedLimit: TRAFFIC.speedLimit, cornerSpeed: TRAFFIC.turnSpeed, slot: TRACKS.car.slot }
    : kind === 'train'
      ? { speedLimit: TRACKS.train.speed, cornerSpeed: TRACKS.train.speed, slot: TRACKS.train.spacing }
      : kind === 'drone'
        ? { speedLimit: TRACKS.drone.speed, cornerSpeed: TRACKS.drone.speed, slot: TRACKS.drone.headway }
        : kind === 'plane'
          ? { speedLimit: TRACKS.plane.speed, cornerSpeed: TRACKS.plane.speed, slot: TRACKS.plane.headway }
          : { speedLimit: TRACKS.vtol.speed, cornerSpeed: TRACKS.vtol.speed, slot: TRACKS.vtol.legMin }
  return Object.freeze({
    id, kind, length, pieces: Object.freeze(pieces), stops: Object.freeze(stops), stations: Object.freeze(stations), pads: Object.freeze(pads), y, ...limits,
  })
}

/** The unit direction and block count of the grid edge from `a` to `b` (axis-aligned, or an Error). */
function edge(a: Vec2, b: Vec2): { dir: Vec2; blocks: number } {
  const dk = b[0] - a[0], dm = b[1] - a[1]
  if ((dk !== 0) === (dm !== 0)) throw new Error(`track edge ${a} → ${b} is not along a street`)
  const blocks = Math.abs(dk + dm)
  return { dir: [Math.sign(dk), Math.sign(dm)], blocks }
}

function turnBetween(dir: Vec2, next: Vec2): Turn {
  if (same(right(dir), next)) return 'right'
  if (same(left(dir), next)) return 'left'
  throw new Error(`a ring corner must turn: ${dir} → ${next}`)
}

/**
 * A closed loop of Bézier turns through grid vertices `corners` in order, on the lane `laneOffset` metres to the
 * right of each street's centreline (negative: to the left). Straights run from ENTRY past one vertex to ENTRY
 * before the next; the corner between is Driver's own turn curve. A car ring gets a stop line at every
 * intersection it passes, corners and straight-through crossings alike, TRAFFIC.stopLine + HALF_LENGTH before
 * the intersection centre.
 */
export function ring(corners: readonly Vec2[], y: number, laneOffset: number, kind: TrackKind = 'car', id = 0): Track {
  const n = corners.length
  if (n < 4) throw new Error('a ring needs at least four corners')
  const pieces: Piece[] = []
  const stops: Stop[] = []
  let s = 0
  for (let i = 0; i < n; i++) {
    const a = corners[i], b = corners[(i + 1) % n], c = corners[(i + 2) % n]
    const { dir, blocks } = edge(a, b)
    const next = edge(b, c).dir
    const turn = turnBetween(dir, next)
    const r = right(dir)
    const x0 = a[0] * CITY.pitch + dir[0] * ENTRY + r[0] * laneOffset
    const z0 = a[1] * CITY.pitch + dir[1] * ENTRY + r[1] * laneOffset
    const length = blocks * CITY.pitch - 2 * ENTRY
    pieces.push(linePiece(s, x0, z0, dir, length))
    if (kind === 'car') {
      for (let j = 1; j <= blocks; j++) stops.push({ s: s + j * CITY.pitch - ENTRY - TRAFFIC.stopLine - HALF_LENGTH, axis: axisOf(dir) })
    }
    s += length
    const { e, c: ctrl, x } = turnBezier(b, dir, next, turn, laneOffset)
    const corner = cornerPiece(s, e, ctrl, x)
    pieces.push(corner)
    s += corner.length
  }
  return makeTrack(id, kind, pieces, stops, [], y)
}

/** The corners of cell (i, j) of a grid tiled in `spacing`-block cells, clockwise (right turns only). */
function cellCorners(i: number, j: number, spacing: number): Vec2[] {
  const k0 = i * spacing, m0 = j * spacing, k1 = k0 + spacing, m1 = m0 + spacing
  return [[k0, m0], [k1, m0], [k1, m1], [k0, m1]]
}

/**
 * The boundary loops of every `spacing`-block cell of a B-block grid, each driven clockwise (right turns only)
 * on the lane `laneOffset` to the right of the centreline, or counter-clockwise (left turns only) on the lane
 * `laneOffset` to the LEFT, which is the same set of lane points traversed the other way. In both families
 * every (segment, direction) belongs to exactly one loop: adjacent cells share a street in opposite lanes, so
 * no two loops share a point (INV-1) and no loop crosses another's path.
 */
export function faceRings(B: number, spacing: number, y: number, laneOffset: number, kind: TrackKind = 'car', clockwise = true): Track[] {
  const cells = Math.floor(B / spacing)
  const out: Track[] = []
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const corners = cellCorners(i, j, spacing)
      if (!clockwise) corners.reverse()
      out.push(ring(corners, y, clockwise ? laneOffset : -laneOffset, kind, out.length))
    }
  }
  return out
}

/** A rectangle's corners rotated so the loop starts at corner `start`. */
function rotated(corners: readonly Vec2[], start: number): Vec2[] {
  return corners.map((_, i) => corners[(i + start) % corners.length])
}

/** The 64 car rings; the seed only picks each ring's starting corner (where its s = 0 lies). */
export function carLoops(seed = 0): Track[] {
  const rng = createRng(seed ^ 0x7ac5)
  const cells = Math.floor(CITY.blocks / TRACKS.car.faceBlocks)
  const out: Track[] = []
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const corners = rotated(cellCorners(i, j, TRACKS.car.faceBlocks), Math.floor(rng() * 4))
      out.push(ring(corners, 0, TRAFFIC.laneOffset, 'car', out.length))
    }
  }
  return out
}

/**
 * The elevated loop: over the centrelines of the two arterial lines of TRACKS.train.corridor, both axes, on a deck
 * TRACKS.train.deck over the street, corners as circular arcs of TRACKS.train.radius (a train cannot take the car
 * Bézier). Four stations, one mid-block platform per side.
 */
export function trainLoops(): Track[] {
  const [lo, hi] = TRACKS.train.corridor
  const corners: Vec2[] = [[lo, lo], [hi, lo], [hi, hi], [lo, hi]]
  const R = TRACKS.train.radius
  const pieces: Piece[] = []
  const stations: number[] = []
  let s = 0
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4], c = corners[(i + 2) % 4]
    const { dir, blocks } = edge(a, b)
    const next = edge(b, c).dir
    const turn = turnBetween(dir, next)
    const length = blocks * CITY.pitch - 2 * R
    pieces.push(linePiece(s, a[0] * CITY.pitch + dir[0] * R, a[1] * CITY.pitch + dir[1] * R, dir, length))
    // The platform sits mid-block on the block nearest the side's middle.
    stations.push(s + (Math.floor(blocks / 2) - 0.5) * CITY.pitch - R)
    s += length
    const side = turn === 'right' ? right(dir) : left(dir)
    const p0x = b[0] * CITY.pitch - dir[0] * R, p0z = b[1] * CITY.pitch - dir[1] * R
    const cx = p0x + side[0] * R, cz = p0z + side[1] * R
    const arc = arcPiece(s, cx, cz, R, Math.atan2(p0z - cz, p0x - cx), turn === 'right' ? Math.PI / 2 : -Math.PI / 2)
    pieces.push(arc)
    s += arc.length
  }
  return [makeTrack(0, 'train', pieces, [], stations, TRACKS.train.deck)]
}

/** Face-ring corridors: clockwise at the first altitude, the same lanes counter-clockwise at the second. */
export function droneCorridors(): Track[] {
  const { altitude, faceBlocks, laneOffset } = TRACKS.drone
  const cw = faceRings(CITY.blocks, faceBlocks, altitude[0], laneOffset, 'drone', true)
  const ccw = faceRings(CITY.blocks, faceBlocks, altitude[1], laneOffset, 'drone', false)
  return [...cw, ...ccw].map((t, id) => Object.freeze({ ...t, id }))
}

/** One racetrack about the city centre: two straights joined by two semicircles, flown clockwise. */
export function planeCorridors(): Track[] {
  const { altitude, halfSize, fillet } = TRACKS.plane
  const cx = CITY_CENTER, cz = CITY_CENTER
  const pieces: Piece[] = []
  let s = 0
  pieces.push(linePiece(s, cx - halfSize, cz - fillet, [1, 0], 2 * halfSize))
  s += 2 * halfSize
  const a1 = arcPiece(s, cx + halfSize, cz, fillet, -Math.PI / 2, Math.PI)
  pieces.push(a1)
  s += a1.length
  pieces.push(linePiece(s, cx + halfSize, cz + fillet, [-1, 0], 2 * halfSize))
  s += 2 * halfSize
  pieces.push(arcPiece(s, cx - halfSize, cz, fillet, Math.PI / 2, Math.PI))
  return [makeTrack(0, 'plane', pieces, [], [], altitude)]
}

/**
 * The whole network from the seed: car rings, the elevated loop, the drone corridors, the racetrack and, given the
 * city's building boxes, the VTOL routes between rooftop pads (none without them); ids 0..n−1.
 */
export function buildTrackNetwork(seed: number, boxes: readonly Box[] = []): TrackNetwork {
  const all = [...carLoops(seed), ...trainLoops(), ...droneCorridors(), ...planeCorridors(), ...vtolRoutes(boxes)]
  return Object.freeze({ seed, tracks: Object.freeze(all.map((t, id) => (t.id === id ? t : Object.freeze({ ...t, id })))) })
}

// ---------------------------------------------------------------- arc-length API

/**
 * A routing core (routingWasm.ts): poseAt, projectOnto, nextStop and speedLimitAt compiled to WebAssembly over
 * tracks laid into its own arena. `laid(track)` says whether it answers for a track (it lays one on first sight when
 * every piece is a line or a corner and it fits); when it does, the exported functions below delegate to it, and
 * otherwise the TypeScript reference answers, as it does everywhere when no core is installed. The physics worker
 * installs one at start; routingWasm.test.ts proves the two equal.
 */
export interface RoutingCore {
  laid(track: Track): boolean
  poseAt(track: Track, s: number): TrackPose
  projectOnto(track: Track, x: number, z: number, sHint: number): { s: number; lateral: number }
  nextStop(track: Track, s: number, behind: number): { s: number; axis: Axis; distance: number } | null
  speedLimitAt(track: Track, s: number): number
}

let core: RoutingCore | null = null

/** Installs the routing core the four functions delegate to for the tracks it has laid (null: the reference alone). */
export function useRoutingCore(c: RoutingCore | null): void {
  core = c
}

/** The routing core installed, or null. */
export function routingCore(): RoutingCore | null {
  return core
}

/** `s` folded into [0, length). */
export function wrap(track: Track, s: number): number {
  const L = track.length
  const w = s % L
  return w < 0 ? w + L : w
}

/** The piece containing `s` (already wrapped). */
export function pieceAt(track: Track, s: number): Piece {
  const pieces = track.pieces
  let lo = 0, hi = pieces.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (pieces[mid].s0 <= s) lo = mid
    else hi = mid - 1
  }
  return pieces[lo]
}

function evalPiece(p: Piece, local: number, out: TrackPose): void {
  if (p.kind === 'line') {
    out.x = p.x0 + p.dx * local
    out.z = p.z0 + p.dz * local
    out.tangentX = p.dx
    out.tangentZ = p.dz
  } else if (p.kind === 'arc') {
    const a = p.a0 + p.sweep * Math.min(1, Math.max(0, local / p.length))
    const sign = p.sweep >= 0 ? 1 : -1
    out.x = p.cx + p.radius * Math.cos(a)
    out.z = p.cz + p.radius * Math.sin(a)
    out.tangentX = -Math.sin(a) * sign
    out.tangentZ = Math.cos(a) * sign
  } else {
    const n = LUT_SIZE - 1
    const u = Math.min(n, Math.max(0, (local / p.length) * n))
    const i = Math.min(n - 1, Math.floor(u))
    const f = u - i
    const t = p.lut[i] + f * (p.lut[i + 1] - p.lut[i])
    const [x, z] = bezierPoint(p.e, p.c, p.x, t)
    const w = 1 - t
    const dx = 2 * w * (p.c[0] - p.e[0]) + 2 * t * (p.x[0] - p.c[0])
    const dz = 2 * w * (p.c[1] - p.e[1]) + 2 * t * (p.x[1] - p.c[1])
    const m = Math.hypot(dx, dz) || 1
    out.x = x
    out.z = z
    out.tangentX = dx / m
    out.tangentZ = dz / m
  }
  out.heading = Math.atan2(out.tangentX, out.tangentZ)
}

/** Position, unit tangent and heading at arc length `s` (any real number; wrapped). */
export function poseAt(track: Track, s: number): TrackPose {
  if (core !== null && core.laid(track)) return core.poseAt(track, s)
  return referencePoseAt(track, s)
}

/** poseAt as written here in TypeScript: the specification a routing core is proved equal to, and the fallback. */
export function referencePoseAt(track: Track, s: number): TrackPose {
  const w = wrap(track, s)
  const p = pieceAt(track, w)
  const out: TrackPose = { x: 0, y: track.y, z: 0, heading: 0, tangentX: 0, tangentZ: 0 }
  evalPiece(p, w - p.s0, out)
  return out
}

/** The unit tangent at `s`. */
export function tangentAt(track: Track, s: number): Vec2 {
  const p = referencePoseAt(track, s)
  return [p.tangentX, p.tangentZ]
}

/** Along-track and (right-positive) lateral offsets of (x, z) from the pose at s. */
function offsets(track: Track, s: number, x: number, z: number): { along: number; lateral: number } {
  const p = referencePoseAt(track, s)
  const ox = x - p.x, oz = z - p.z
  return { along: ox * p.tangentX + oz * p.tangentZ, lateral: ox * -p.tangentZ + oz * p.tangentX }
}

/** Newton steps s ← s + along (each clamped to ±clamp) until the step is below a tenth of a millimetre. */
function refine(track: Track, s: number, x: number, z: number, steps: number, clamp: number): number {
  for (let i = 0; i < steps; i++) {
    const { along } = offsets(track, s, x, z)
    const step = Math.max(-clamp, Math.min(clamp, along))
    s = wrap(track, s + step)
    if (Math.abs(step) < 1e-4) break
  }
  return s
}

/**
 * The arc length nearest (x, z) and the lateral offset there (positive to the right of travel, the side the
 * lane offset lies on). With a hint, up to six Newton steps from it (each clamped to ±NEWTON_STEP m); without
 * one, or when the hint does not converge or leaves the point more than HINT_LATERAL m off the track, a global
 * search over every piece (closed form on lines, a scan every NEWTON_STEP m on curves) and the same refinement.
 */
export function projectOnto(track: Track, x: number, z: number, sHint = NaN): { s: number; lateral: number } {
  if (core !== null && core.laid(track)) return core.projectOnto(track, x, z, sHint)
  return referenceProjectOnto(track, x, z, sHint)
}

/** projectOnto as written here in TypeScript (the reference and the fallback). */
export function referenceProjectOnto(track: Track, x: number, z: number, sHint = NaN): { s: number; lateral: number } {
  if (Number.isFinite(sHint)) {
    const s = refine(track, wrap(track, sHint), x, z, 6, NEWTON_STEP)
    const { along, lateral } = offsets(track, s, x, z)
    if (Math.abs(along) < 1e-3 && Math.abs(lateral) <= HINT_LATERAL) return { s, lateral }
  }
  let best = Infinity, bestS = 0
  const probe: TrackPose = { x: 0, y: track.y, z: 0, heading: 0, tangentX: 0, tangentZ: 0 }
  for (const p of track.pieces) {
    if (p.kind === 'line') {
      const local = Math.max(0, Math.min(p.length, (x - p.x0) * p.dx + (z - p.z0) * p.dz))
      const d = Math.hypot(x - (p.x0 + p.dx * local), z - (p.z0 + p.dz * local))
      if (d < best) { best = d; bestS = p.s0 + local }
    } else {
      const samples = Math.max(16, Math.ceil(p.length / NEWTON_STEP))
      for (let i = 0; i <= samples; i++) {
        const local = (i / samples) * p.length
        evalPiece(p, local, probe)
        const d = Math.hypot(x - probe.x, z - probe.z)
        if (d < best) { best = d; bestS = p.s0 + local }
      }
    }
  }
  const s = refine(track, bestS, x, z, 6, NEWTON_STEP)
  return { s, lateral: offsets(track, s, x, z).lateral }
}

/**
 * The stop line a car at `s` answers to: its s, axis and the signed distance to it. A stop stays current until
 * the car is `behind` metres past it (STOP_CLEAR: its rear bumper has left the intersection box), so the
 * distance may be negative; then the next stop ahead takes over. Null on a track without stops.
 */
export function nextStop(track: Track, s: number, behind: number = STOP_CLEAR): { s: number; axis: Axis; distance: number } | null {
  if (core !== null && core.laid(track)) return core.nextStop(track, s, behind)
  return referenceNextStop(track, s, behind)
}

/** nextStop as written here in TypeScript (the reference and the fallback). */
export function referenceNextStop(track: Track, s: number, behind: number = STOP_CLEAR): { s: number; axis: Axis; distance: number } | null {
  let best: { s: number; axis: Axis; distance: number } | null = null
  const w = wrap(track, s)
  for (const stop of track.stops) {
    const distance = wrap(track, stop.s - w + behind) - behind
    if (best === null || distance < best.distance) best = { s: stop.s, axis: stop.axis, distance }
  }
  return best
}

/**
 * Free road a car `toStop` metres before a stop line needs ahead to pass the line and leave the intersection
 * box with its following margin: a driver that holds at the line while its gap is smaller never blocks the box,
 * so a queue for the next stop never leaves a car standing on a crosswalk through a red.
 */
export function roomToClear(toStop: number): number {
  return toStop + STOP_CLEAR + FOLLOW_STOP
}

/** Metres from `s` to the start of the next curved piece (0 inside one; Infinity on a track of straights). */
export function cornerAhead(track: Track, s: number): number {
  const w = wrap(track, s)
  if (pieceAt(track, w).kind !== 'line') return 0
  let best = Infinity
  for (const p of track.pieces) {
    if (p.kind === 'line') continue
    const d = wrap(track, p.s0 - w)
    if (d < best) best = d
  }
  return best
}

/**
 * The speed a track vehicle may hold at `s`: cornerSpeed inside a curve, and before one the anticipation
 * v ≤ sqrt(cornerSpeed² + 2 · comfortableDecel · distance) that traffic.ts:181 applies, capped at the limit.
 */
export function speedLimitAt(track: Track, s: number): number {
  if (core !== null && core.laid(track)) return core.speedLimitAt(track, s)
  return referenceSpeedLimitAt(track, s)
}

/** speedLimitAt as written here in TypeScript (the reference and the fallback). */
export function referenceSpeedLimitAt(track: Track, s: number): number {
  const d = cornerAhead(track, s)
  if (d === 0) return track.cornerSpeed
  return Math.min(track.speedLimit, Math.sqrt(track.cornerSpeed * track.cornerSpeed + 2 * TRAFFIC.comfortableDecel * d))
}

// ---------------------------------------------------------------- headway slots

export function slotCount(track: Track): number {
  return Math.floor(track.length / track.slot)
}

/** The centre of slot `k`. */
export function slotStart(track: Track, k: number): number {
  return k * track.slot + track.slot / 2
}

/** True when a car centred at `s` stands on a straight, clear of every intersection box and behind every stop line. */
export function seatable(track: Track, s: number): boolean {
  const w = wrap(track, s)
  if (pieceAt(track, w).kind !== 'line') return false
  for (const stop of track.stops) {
    const past = wrap(track, w - stop.s)
    if (past > 0 && past < STOP_CLEAR) return false
  }
  return true
}

/** The slots a fleet may seat a car in: the seatable ones, and never every slot (one is always left free). */
export function seats(track: Track): number[] {
  const out: number[] = []
  for (let k = 0; k < slotCount(track); k++) if (seatable(track, slotStart(track, k))) out.push(k)
  return out.slice(0, Math.max(0, slotCount(track) - 1))
}

/**
 * Cars a track can carry: its seats. On a car ring about half the slots lie in a stop-to-box zone, so the
 * capacity is what a ring holds with every car clear of the intersections and a queue at each stop line short
 * enough for the ring to keep flowing under the don't-block-the-box rule (roomToClear).
 */
export function capacity(track: Track): number {
  return seats(track).length
}

/**
 * Seats `count` cars on the network's car tracks: tracks drawn with probability proportional to length among
 * those with a free seat, then a free seat of that track, so every (track, slot) pair is distinct, every car
 * stands on a straight clear of the intersection boxes, and every gap at spawn is at least TRACKS.car.headway.
 * Throws when count exceeds the sum of capacities.
 */
export function assignSlots(network: TrackNetwork, count: number, rng: () => number): { track: number; s: number }[] {
  const cars = network.tracks.filter((t) => t.kind === 'car')
  const free = cars.map(seats)
  const total = free.reduce((n, f) => n + f.length, 0)
  if (count > total) throw new Error(`${count} cars exceed the network's ${total} seats`)
  const out: { track: number; s: number }[] = []
  for (let i = 0; i < count; i++) {
    const open = cars.map((_, j) => j).filter((j) => free[j].length > 0)
    const weight = open.reduce((w, j) => w + cars[j].length, 0)
    let r = rng() * weight
    let j = open[open.length - 1]
    for (const candidate of open) {
      if ((r -= cars[candidate].length) < 0) { j = candidate; break }
    }
    const k = free[j].splice(Math.floor(rng() * free[j].length), 1)[0]
    out.push({ track: cars[j].id, s: slotStart(cars[j], k) })
  }
  return out
}

/**
 * Bumper-to-bumper gap ahead of each car of one ring, given their arc lengths in ascending order: the car
 * ahead of the last is the first, a lap on. Infinity for a car alone on its ring.
 */
export function ringGaps(sSorted: Float64Array, length: number, carLength: number): Float64Array {
  const n = sSorted.length
  const out = new Float64Array(n)
  if (n === 1) {
    out[0] = Infinity
    return out
  }
  for (let i = 0; i < n; i++) {
    const ahead = i + 1 < n ? sSorted[i + 1] : sSorted[0] + length
    out[i] = ahead - sSorted[i] - carLength
  }
  return out
}

// ---------------------------------------------------------------- timetables

interface Leg { run: number; accel: number; cruise: number; peak: number; distance: number }

/** The train's legs between consecutive stations: accelerate at comfortableDecel, cruise, brake, dwell. */
function legs(track: Track): Leg[] {
  const a = TRAFFIC.comfortableDecel, v = track.speedLimit
  return track.stations.map((from, i) => {
    const to = track.stations[(i + 1) % track.stations.length]
    const distance = i + 1 < track.stations.length ? to - from : to + track.length - from
    const ramp = (v * v) / a
    if (distance >= ramp) {
      const cruise = (distance - ramp) / v
      return { run: (2 * v) / a + cruise, accel: v / a, cruise, peak: v, distance }
    }
    const peak = Math.sqrt(a * distance)
    return { run: (2 * peak) / a, accel: peak / a, cruise: 0, peak, distance }
  })
}

/** Seconds one vehicle takes for a lap: the train timetable with its dwells, a VTOL route's with its pad calls, or length / speed. */
export function lapSeconds(track: Track): number {
  if (track.kind === 'train' && track.stations.length > 0) return legs(track).reduce((t, l) => t + l.run + TRACKS.train.dwell, 0)
  if (track.kind === 'vtol') return legs(track).reduce((t, l, i) => t + l.run + padTime(track, i), 0)
  return track.length / track.speedLimit
}

/** Arc length of a train `tau` seconds after leaving its first station. */
function timetable(track: Track, tau: number): number {
  const a = TRAFFIC.comfortableDecel
  let s = track.stations[0]
  for (const leg of legs(track)) {
    if (tau < leg.run) {
      const d = tau < leg.accel
        ? (a * tau * tau) / 2
        : tau < leg.accel + leg.cruise
          ? (leg.peak * leg.peak) / (2 * a) + leg.peak * (tau - leg.accel)
          : leg.distance - (a * (leg.run - tau) * (leg.run - tau)) / 2
      return wrap(track, s + d)
    }
    tau -= leg.run
    s = wrap(track, s + leg.distance)
    if (tau < TRACKS.train.dwell) return s
    tau -= TRACKS.train.dwell
  }
  return s
}

/**
 * Where vehicle `index` of `count` on a scheduled track stands at realm time `t`: a pure function of t, so
 * vehicles never interact. Trains follow the timetable (dwelling TRACKS.train.dwell s at every station), sets
 * a lap-time / count apart; drones and planes hold constant speed a length / count apart.
 */
export function scheduledPose(track: Track, index: number, count: number, t: number): TrackPose {
  if (track.kind === 'train' && track.stations.length > 0) {
    const T = lapSeconds(track)
    const tau = ((((t + (index * T) / count) % T) + T) % T)
    return poseAt(track, timetable(track, tau))
  }
  if (track.kind === 'vtol') {
    const v = vtolSchedule(track, index, count, t)
    const p = poseAt(track, v.s)
    p.y = v.y
    p.heading = v.heading
    p.tangentX = Math.sin(v.heading)
    p.tangentZ = Math.cos(v.heading)
    return p
  }
  return poseAt(track, (index * track.length) / count + track.speedLimit * t)
}

/** How many vehicles a scheduled track carries: the train sets, one drone per headway, the planes. */
export function scheduledCount(track: Track): number {
  if (track.kind === 'train') return TRACKS.train.sets
  if (track.kind === 'plane') return TRACKS.plane.count
  if (track.kind === 'drone') return Math.max(1, Math.floor(track.length / TRACKS.drone.headway))
  if (track.kind === 'vtol') return TRACKS.vtol.craft
  return 0
}

// ---------------------------------------------------------------- guideway

/**
 * The elevated loop's structure for a renderer: column pairs on both curbs (CITY.furniture from the centreline)
 * at TRACKS.train.columns metres into each block along the straights, clear of the lamps at 10 and 30 m, the
 * trees at 20 m, the signal poles at the corners and the car rings' corner curves; a beam between each pair.
 * Empty for any other track.
 */
export function guideway(track: Track): { columns: [number, number][]; beams: [number, number, number, number][] } {
  const columns: [number, number][] = []
  const beams: [number, number, number, number][] = []
  if (track.kind !== 'train') return { columns, beams }
  const R = TRACKS.train.radius
  for (const p of track.pieces) {
    if (p.kind !== 'line') continue
    const r = right(p.dir)
    const blocks = Math.round((p.length + 2 * R) / CITY.pitch)
    for (let j = 0; j < blocks; j++) {
      for (const a of TRACKS.train.columns) {
        const along = j * CITY.pitch + a - R
        if (along < 0 || along > p.length) continue
        const x = p.x0 + p.dx * along, z = p.z0 + p.dz * along
        const c0: [number, number] = [x + r[0] * CITY.furniture, z + r[1] * CITY.furniture]
        const c1: [number, number] = [x - r[0] * CITY.furniture, z - r[1] * CITY.furniture]
        columns.push(c0, c1)
        beams.push([c0[0], c0[1], c1[0], c1[1]])
      }
    }
  }
  return { columns, beams }
}

// ---------------------------------------------------------------- VTOL routes

/**
 * The cells a route's four pads are chosen from, in loop order, as block rectangles [k0, k1) × [m0, m1) of the city
 * grid (CITY.pitch m a block): the inner route rounds downtown's four quarters, the outer one the four sides around
 * them. The heritage columns (k < 4), the lakefront and the park (m ≥ 14) have no roof high enough for a pad.
 */
const VTOL_CELLS: readonly (readonly (readonly [number, number, number, number])[])[] = Object.freeze([
  Object.freeze([[5, 8, 4, 8], [8, 12, 4, 8], [8, 12, 8, 12], [5, 8, 8, 12]] as const),
  Object.freeze([[4, 12, 1, 4], [12, 15, 4, 12], [4, 12, 12, 14], [4, 5, 4, 12]] as const),
])
/** Most candidates kept per cell, the tallest first: the search below is at most this to the fourth. */
const VTOL_CHOICES = 10
/** Most whole loops a route's search flies before giving the route up. */
const VTOL_LOOPS = 64
/** Metres between the samples a leg is checked at. */
const VTOL_STEP = 1
/**
 * Radius of the curve a VTOL flies through a turn, m: at an intersection it cuts 0.35 R toward the inside corner,
 * which at this radius keeps the envelope over the road and the sidewalk, clear of a tower built to the lot's corner.
 */
const VTOL_TURN = 12

/** Horizontal distance from (x, z) to a box, 0 inside its footprint. */
function boxGap(x: number, z: number, b: Box): number {
  const dx = Math.max(b[0] - x, 0, x - b[3]), dz = Math.max(b[2] - z, 0, z - b[5])
  return Math.hypot(dx, dz)
}

/** The boxes by CITY.pitch cell of their footprint, for the leg checks. */
function boxCells(boxes: readonly Box[]): Map<number, Box[]> {
  const cell = CITY.pitch
  const hash = new Map<number, Box[]>()
  for (const b of boxes) {
    for (let i = Math.floor(b[0] / cell); i <= Math.floor(b[3] / cell); i++) for (let j = Math.floor(b[2] / cell); j <= Math.floor(b[5] / cell); j++) {
      const k = (i + 64) * 4096 + (j + 64)
      const list = hash.get(k)
      if (list) list.push(b); else hash.set(k, [b])
    }
  }
  return hash
}

function boxesNear(hash: Map<number, Box[]>, x: number, z: number, out: Box[]): Box[] {
  out.length = 0
  const cx = Math.floor(x / CITY.pitch), cz = Math.floor(z / CITY.pitch)
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const list = hash.get((cx + i + 64) * 4096 + (cz + j + 64))
    if (list) for (const b of list) out.push(b)
  }
  return out
}

/**
 * The roofs that take a pad: a box whose top lies between the floor and the ceiling, at least `padHalf` each way, with
 * nothing taller standing within the craft's descent column (its envelope about the roof's centre): the topmost roof
 * of its lot there, so a craft coming straight down onto it meets nothing. In box order, so the choice is as fixed as
 * the boxes.
 */
export function vtolPads(boxes: readonly Box[]): Pad[] {
  const { floor, ceiling, padHalf, halfSize } = TRACKS.vtol
  const hash = boxCells(boxes)
  const near: Box[] = []
  const out: Pad[] = []
  for (const b of boxes) {
    const top = b[4]
    if (top < floor || top > ceiling) continue
    if ((b[3] - b[0]) / 2 < padHalf || (b[5] - b[2]) / 2 < padHalf) continue
    const cx = (b[0] + b[3]) / 2, cz = (b[2] + b[5]) / 2
    let topmost = true
    for (const o of boxesNear(hash, cx, cz, near)) {
      if (o === b || o[4] <= top) continue
      if (o[0] < cx + halfSize && o[3] > cx - halfSize && o[2] < cz + halfSize && o[5] > cz - halfSize) { topmost = false; break }
    }
    if (topmost) out.push(Object.freeze({ x: cx, z: cz, y: top }))
  }
  return out
}

/**
 * Where a pad's route meets the street: the middle of the nearest street's block beside the pad (a street's centreline
 * is the one line over a block that no building stands on, and the block's middle is as far from both intersections
 * as a point on it gets, so the turn onto the hop and the turn at the intersection both fit). `axis` is the street's.
 */
function streetFoot(pad: Pad): { x: number; z: number; axis: Axis } {
  const pitch = CITY.pitch
  const kx = Math.round(pad.x / pitch) * pitch, mz = Math.round(pad.z / pitch) * pitch
  if (Math.abs(pad.x - kx) <= Math.abs(pad.z - mz)) return { x: kx, z: (Math.floor(pad.z / pitch) + 0.5) * pitch, axis: 'ns' }
  return { x: (Math.floor(pad.x / pitch) + 0.5) * pitch, z: mz, axis: 'ew' }
}

/** The corners of the street path from one foot to another, along the centrelines: at most two turns. */
function streetPath(a: ReturnType<typeof streetFoot>, b: ReturnType<typeof streetFoot>): Vec2[] {
  const pitch = CITY.pitch
  if (a.axis === 'ns' && b.axis === 'ew') return [[a.x, b.z]]
  if (a.axis === 'ew' && b.axis === 'ns') return [[b.x, a.z]]
  if (a.axis === 'ns') {
    if (a.x === b.x) return []
    const c = Math.round((a.z + b.z) / 2 / pitch) * pitch
    return [[a.x, c], [b.x, c]]
  }
  if (a.z === b.z) return []
  const c = Math.round((a.x + b.x) / 2 / pitch) * pitch
  return [[c, a.z], [c, b.z]]
}

/**
 * The way from pad `a` to pad `b`: up the hop to a's street foot, the street path, and down the hop onto b. Consecutive
 * repeats are dropped (two pads whose feet are one point fly hop to hop).
 */
function legWaypoints(a: Pad, b: Pad): Vec2[] {
  const fa = streetFoot(a), fb = streetFoot(b)
  const raw: Vec2[] = [[a.x, a.z], [fa.x, fa.z], ...streetPath(fa, fb), [fb.x, fb.z], [b.x, b.z]]
  const out: Vec2[] = []
  for (const p of raw) if (out.length === 0 || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 1e-6) out.push(p)
  return out
}

/**
 * The pieces of a polyline flown from its first point to its last: a straight for each segment and, at each inner
 * point where the way bends, a curve of radius VTOL_TURN (less where a segment is short: at most half of each of its
 * two segments, so two curves on one segment never overlap), with the point itself as the control. Arc lengths
 * start at `s0`.
 */
function polylinePieces(points: readonly Vec2[], s0: number): Piece[] {
  const n = points.length
  const seg = (i: number): number => Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1])
  const dir = (i: number): Vec2 => { const l = seg(i); return [(points[i + 1][0] - points[i][0]) / l, (points[i + 1][1] - points[i][1]) / l] }
  // The curve at each inner point: none where the way runs straight on.
  const cuts: number[] = points.map((_, i) => {
    if (i === 0 || i === n - 1) return 0
    const d1 = dir(i - 1), d2 = dir(i)
    return Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) > 1e-3 ? Math.min(VTOL_TURN, seg(i - 1) / 2, seg(i) / 2) : 0
  })
  const pieces: Piece[] = []
  let s = s0
  for (let i = 0; i + 1 < n; i++) {
    const d = dir(i)
    const length = seg(i) - cuts[i] - cuts[i + 1]
    if (length > 1e-6) {
      const x0 = points[i][0] + d[0] * cuts[i], z0 = points[i][1] + d[1] * cuts[i]
      pieces.push(linePiece(s, x0, z0, d, length))
      s += length
    }
    if (cuts[i + 1] > 0) {
      const at = points[i + 1], d2 = dir(i + 1), cut = cuts[i + 1]
      const corner = cornerPiece(s, [at[0] - d[0] * cut, at[1] - d[1] * cut], at, [at[0] + d2[0] * cut, at[1] + d2[1] * cut])
      pieces.push(corner)
      s += corner.length
    }
  }
  return pieces
}

/** The pose along one piece, by its own local arc length. */
function pieceSample(p: Piece, local: number): TrackPose {
  const out: TrackPose = { x: 0, y: 0, z: 0, heading: 0, tangentX: 0, tangentZ: 0 }
  evalPiece(p, local, out)
  return out
}

/**
 * Whether a leg flown at `cruise` is clear: at least `legMin` long, every box within the envelope's half-size of any
 * point of it topping out `clearance` under the envelope's bottom, and no pad of `others` (any pad that is not one of
 * its ends) nearer than `apart` to any point of it.
 */
function legClear(pieces: readonly Piece[], a: Pad, b: Pad, cruise: number, others: readonly Pad[], hash: Map<number, Box[]>, near: Box[]): boolean {
  const { halfSize, halfHeight, clearance, apart, legMin } = TRACKS.vtol
  const last = pieces[pieces.length - 1]
  if (last.s0 + last.length - pieces[0].s0 < legMin) return false
  const ceiling = cruise - halfHeight - clearance
  for (const p of pieces) {
    const n = Math.ceil(p.length / VTOL_STEP)
    for (let i = 0; i <= n; i++) {
      const q = pieceSample(p, (i / n) * p.length)
      for (const o of boxesNear(hash, q.x, q.z, near)) if (o[4] > ceiling && boxGap(q.x, q.z, o) < halfSize) return false
      for (const pad of others) if (pad !== a && pad !== b && Math.hypot(pad.x - q.x, pad.z - q.z) < apart) return false
    }
  }
  return true
}

/**
 * The VTOL routes of a city: for each route, one pad in each of its four cells (VTOL_CELLS), the tallest roofs first,
 * such that every leg of the loop is clear (legClear) against every pad of the city's routes, and the loop's pads are
 * `apart` from each other. A city whose boxes give no such loop for a route has no such route; a city given no boxes
 * has none at all. Pure in the boxes: the same boxes always give the same routes, in the same order.
 */
export function vtolRoutes(boxes: readonly Box[]): Track[] {
  if (boxes.length === 0) return []
  const { cruise, apart, routes } = TRACKS.vtol
  const pads = vtolPads(boxes)
  const hash = boxCells(boxes)
  const near: Box[] = []
  const chosen: Track[] = []
  const pitch = CITY.pitch
  for (let r = 0; r < routes; r++) {
    const y = cruise[r]
    const taken = chosen.flatMap((t) => t.stations.map((s, i) => ({ ...referencePoseAt(t, s), y: t.pads[i] })))
    const options = VTOL_CELLS[r].map(([k0, k1, m0, m1]) => pads
      .filter((p) => p.x >= k0 * pitch && p.x < k1 * pitch && p.z >= m0 * pitch && p.z < m1 * pitch)
      .filter((p) => taken.every((q) => Math.hypot(q.x - p.x, q.z - p.z) >= apart))
      .sort((a, b) => b.y - a.y || a.x - b.x || a.z - b.z)
      .slice(0, VTOL_CHOICES))
    if (options.some((o) => o.length === 0)) continue
    const memo = new Map<Pad, Map<Pad, boolean>>()
    const ok = (a: Pad, b: Pad, loop: readonly Pad[]): boolean => {
      let row = memo.get(a)
      if (!row) memo.set(a, (row = new Map()))
      let v = row.get(b)
      if (v === undefined) row.set(b, (v = legClear(polylinePieces(legWaypoints(a, b), 0), a, b, y, [...taken, ...options.flat()], hash, near)))
      return v && loop.every((q) => q === a || q === b || legClear(polylinePieces(legWaypoints(a, b), 0), a, b, y, [q], hash, near))
    }
    let found: Track | null = null
    let tried = 0
    search: for (const p0 of options[0]) for (const p1 of options[1]) {
      if (!ok(p0, p1, [])) continue
      for (const p2 of options[2]) {
        if (!ok(p1, p2, []) || !ok(p0, p1, [p2])) continue
        for (const p3 of options[3]) {
          if (!ok(p2, p3, [p0]) || !ok(p3, p0, [p1, p2]) || !ok(p0, p1, [p3]) || !ok(p1, p2, [p3, p0])) continue
          // A loop doubles back on itself (every pad's hop, a street flown both ways): its craft, a lap / count apart in
          // time, must still keep two envelopes and a metre apart everywhere; a loop whose craft would meet is not flown.
          const track = loopTrack([p0, p1, p2, p3], y)
          if (++tried > VTOL_LOOPS) break search
          if (!loopSafe(track)) continue
          found = track
          break search
        }
      }
    }
    if (!found) continue
    chosen.push(found)
  }
  return chosen
}

/** The track of a loop of pads flown at `cruise`: a station at each pad, a leg (legWaypoints) from each to the next. */
function loopTrack(loop: readonly Pad[], cruise: number): Track {
  const pieces: Piece[] = []
  const stations: number[] = []
  let s = 0
  for (let i = 0; i < loop.length; i++) {
    stations.push(s)
    const leg = polylinePieces(legWaypoints(loop[i], loop[(i + 1) % loop.length]), s)
    pieces.push(...leg)
    const last = leg[leg.length - 1]
    s = last.s0 + last.length
  }
  return makeTrack(0, 'vtol', pieces, [], stations, cruise, loop.map((p) => p.y))
}

/** Whether the craft of a VTOL route keep two envelopes and a metre apart through a whole lap, sampled every quarter second. */
function loopSafe(track: Track): boolean {
  const n = TRACKS.vtol.craft
  const T = lapSeconds(track)
  const least = 2 * TRACKS.vtol.halfSize + 1
  for (let t = 0; t < T; t += 0.25) {
    for (let i = 0; i < n; i++) {
      const p = scheduledPose(track, i, n, t)
      for (let j = i + 1; j < n; j++) {
        const q = scheduledPose(track, j, n, t)
        if (Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) < least) return false
      }
    }
  }
  return true
}

/** Seconds a VTOL spends at pad `i` of its route: down from cruise to the roof, the dwell, and up again. */
function padTime(track: Track, i: number): number {
  const { climb, dwell, hover } = TRACKS.vtol
  return (2 * (track.y - (track.pads[i] + hover))) / climb + dwell
}

const smoothstep = (u: number): number => { const v = Math.min(1, Math.max(0, u)); return v * v * (3 - 2 * v) }

/** The way a VTOL route leaves station `i` (`out`) or arrives at it: the track's heading a hair past or short of it. */
function stationHeading(track: Track, i: number, out: boolean): number {
  const s = track.stations[i % track.stations.length]
  return referencePoseAt(track, s + (out ? 0.01 : -0.01)).heading
}

/** The angle from a to b, in (−π, π]. */
function turnOf(a: number, b: number): number {
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  if (d <= -Math.PI) d += TAU
  return d
}
const TAU = Math.PI * 2

/** Where a VTOL stands in its cycle: arc length along its route, height, heading and speed along the route. */
export interface VtolState { s: number; y: number; heading: number; speed: number }

/**
 * Craft `index` of `count` on a VTOL route at realm time `t`: a pure function of t. Its cycle starts over pad 0 at
 * cruise: it comes straight down at the climb speed (eased at both ends), sits `dwell` seconds turning to face the
 * next leg, climbs back, then flies the leg at the train's comfortable acceleration to its speed and brakes to a stop
 * over the next pad. Craft on one route are a lap / count apart in time.
 */
export function vtolSchedule(track: Track, index: number, count: number, t: number): VtolState {
  const { climb, dwell, hover } = TRACKS.vtol
  const a = TRAFFIC.comfortableDecel
  const T = lapSeconds(track)
  let tau = ((((t + (index * T) / count) % T) + T) % T)
  const n = track.stations.length
  const ls = legs(track)
  let s = track.stations[0]
  for (let i = 0; i < n; i++) {
    const base = track.pads[i] + hover
    const drop = track.y - base
    const down = drop / climb
    const P = 2 * down + dwell
    if (tau < P) {
      const arrive = stationHeading(track, i, false), depart = stationHeading(track, i, true)
      let y: number, heading: number
      if (tau < down) {
        y = track.y - drop * smoothstep(tau / down)
        heading = arrive
      } else if (tau < down + dwell) {
        y = base
        heading = arrive + turnOf(arrive, depart) * smoothstep((tau - down) / dwell)
      } else {
        y = base + drop * smoothstep((tau - down - dwell) / down)
        heading = depart
      }
      return { s, y, heading, speed: 0 }
    }
    tau -= P
    const leg = ls[i]
    if (tau < leg.run) {
      const d = tau < leg.accel
        ? (a * tau * tau) / 2
        : tau < leg.accel + leg.cruise
          ? (leg.peak * leg.peak) / (2 * a) + leg.peak * (tau - leg.accel)
          : leg.distance - (a * (leg.run - tau) * (leg.run - tau)) / 2
      const speed = tau < leg.accel ? a * tau : tau < leg.accel + leg.cruise ? leg.peak : a * (leg.run - tau)
      return { s: wrap(track, s + d), y: track.y, heading: referencePoseAt(track, s + d).heading, speed }
    }
    tau -= leg.run
    s = wrap(track, s + leg.distance)
  }
  return { s, y: track.y, heading: stationHeading(track, 0, true), speed: 0 }
}
