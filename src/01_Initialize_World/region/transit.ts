// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the transit map of a generated region's street window (streets.ts): what the
 * lakefront metropolis gets over and beside its streets that the procedural city has had since the fixed track network
 * (06_Make_Decisions/tracks.ts), laid over the window's own streets instead of the city's grid, and a little more:
 * - the elevated train loop (tracks.ts trainLoop) round a rectangle of the window's walkable streets: the city's own
 *   corridor when the window has all four of its sides, else the largest rectangle that has them, its guideway columns
 *   at the window's own kerb (WINDOW_GEOMETRY.furniture, 3.9 m, clear of the lamps, the trees, the signals and the
 *   two-lane carriageway);
 * - the drone corridors over the window's 4-block cells whose every side has a sidewalk, the plane racetrack about the
 *   window's middle (moved by whole blocks until it clears every needle taller than its altitude: The Spire), and the
 *   VTOL routes between the roofs of the window's own lots (tracks.ts vtolRoutes over the window's cells);
 * - the whole network in the realm's order (windowNetwork), built in the physics worker and on the page from the same
 *   seed, window and craft boxes, so the deck lies under the trains and the pads under the VTOLs by construction;
 * - the zebra crossings at every intersection arm with a sidewalk, as rectangles the region's renderer paints;
 * - the ferry dock: a pier from the shore nearest the window out over the lake, a berth platform at its end, as boxes
 *   the renderer and the colliders take, and the opening it needs through the shore wall;
 * - the STOL strip: a paved runway with threshold bars and a centreline on the open land nearest the window.
 * Pure: no three.js, no DOM, no physics handle; the worker reads windowNetwork, and transit.test.ts proves every corridor
 * clear of every box over the window (INV-1), as tracks.test.ts proves the city's. The loop is elevated only: no
 * subterranean line is built. Planes fly the racetrack at 400 m and never land: the strip is a place, not a schedule.
 * What breaks if it is removed? Lakefront Metro has cars and people but no trains, drones, planes or VTOLs, no
 * crossings painted, no pier and no strip: the realm's craft stream is empty in a region, as it was.
 */
import { CITY, STYLE, type Box, type Building } from '../city.ts'
import { TRAFFIC } from '../../02_Define_The_Rules/civic.ts'
import { TRACKS, VTOL_CELLS, planeCorridors, poseAt, ring, trainLoop, vtolPads, vtolRoutes, type Pad, type Track, type TrackNetwork, type Vec2, type VtolBand, type VtolCells } from '../../06_Make_Decisions/tracks.ts'
import { isRect, type Pt, type Rect } from './clip.ts'
import { DM, ROAD_CLASS, polygonAt, polygonCount, roadAt, type RegionPack } from './pack.ts'
import type { RegionLayout } from './regionWorld.ts'
import { SEG, SIDEWALK, hSeg, roadWidth, streetLoops, vSeg, type StreetGrid } from './streets.ts'
import { buildingLot } from './workplaces.ts'

const P = CITY.pitch

/** Where a region sits: the layout's offset (pack metres to engine metres) and its bounds in the engine's frame. */
type Layout = Pick<RegionLayout, 'offset' | 'bounds'>

export const TRANSIT = Object.freeze({
  /** Least side, blocks, of the rectangle the elevated loop rounds when the window lacks the city's corridor. */
  loopMin: 4,
  /** A zebra crossing: the stripes' width and pitch across the carriageway, m, and the kerb kept clear at each end. */
  crosswalk: Object.freeze({ stripe: 0.5, pitch: 1.0, inset: 0.2 }),
  /**
   * The pier: half-width, the deck's length from the quay, the deck and the rail heights (the city's LAKE.pier), the
   * rail's thickness, the berth platform at its end, the berth's length (a ferry, when one is built), the spacing of
   * the shore points tried, and how far from the shore a street counts as the quay's.
   */
  pier: Object.freeze({
    halfWidth: 4, length: 60, deck: 0.3, rail: 1.1, railThickness: 0.2,
    platform: Object.freeze({ length: 10, halfWidth: 10 }),
    berth: 20, step: 4, quayReach: 6,
  }),
  /**
   * The STOL strip: paved length and width, the margin kept clear round it, the threshold bars (each side of the
   * centreline, at these offsets, this wide, from `from` to `to` m in from each end) and the centreline dashes, m.
   */
  strip: Object.freeze({
    length: 300, width: 24, margin: 2,
    threshold: Object.freeze({ offsets: Object.freeze([2.0, 4.5, 7.0, 9.5] as const), width: 1.8, from: 6, to: 36 }),
    centreline: Object.freeze({ width: 0.9, on: 30, off: 20, from: 50 }),
  }),
  /** The racetrack is moved off the window's middle by whole blocks, up to this many rings out, to clear every needle. */
  racetrackRings: 8,
  /** Horizontal room the racetrack keeps from a needle (a box taller than its envelope's bottom), beyond the envelope's half-length. */
  needleMargin: 1,
})

/** The most craft boxes the physics worker takes in one init (simHost.ts): the window's lots and the ring round them, the needles and the plan are a few hundred. */
export const MAX_CRAFT_BOXES = 4096

const walk = (bits: number): boolean => (bits & SEG.walk) !== 0
const drive = (bits: number): boolean => (bits & SEG.drive) !== 0
const rect = (xa: number, za: number, xb: number, zb: number): Rect => ({ x0: Math.min(xa, xb), z0: Math.min(za, zb), x1: Math.max(xa, xb), z1: Math.max(za, zb) })
const grow = (r: Rect, m: number): Rect => ({ x0: r.x0 - m, z0: r.z0 - m, x1: r.x1 + m, z1: r.z1 + m })
const overlaps = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0
const inside = (r: Rect, b: Rect, margin: number): boolean => r.x0 >= b.x0 + margin && r.z0 >= b.z0 + margin && r.x1 <= b.x1 - margin && r.z1 <= b.z1 - margin
const shift = (l: Layout, pts: readonly Pt[]): Pt[] => pts.map(([x, z]) => [x + l.offset.x, z + l.offset.z] as Pt)

/** The window's middle, engine metres. */
export const windowCentre = (g: StreetGrid): Vec2 => [g.originX + (g.blocks * P) / 2, g.originZ + (g.blocks * P) / 2]

/** Horizontal distance from (x, z) to a box's footprint, 0 inside it. */
function boxGap(x: number, z: number, b: Box): number {
  const dx = Math.max(b[0] - x, 0, x - b[3]), dz = Math.max(b[2] - z, 0, z - b[5])
  return Math.hypot(dx, dz)
}

/** Whether every side segment of the window rectangle [k0, k1] × [m0, m1] (window block corners) has a sidewalk. */
export function walkableRectangle(g: StreetGrid, k0: number, m0: number, k1: number, m1: number): boolean {
  for (let k = k0; k < k1; k++) if (!walk(hSeg(g, k, m0)) || !walk(hSeg(g, k, m1))) return false
  for (let m = m0; m < m1; m++) if (!walk(vSeg(g, k0, m)) || !walk(vSeg(g, k1, m))) return false
  return true
}

// ---------------------------------------------------------------- the elevated loop

/**
 * The window rectangle the elevated loop rounds, as window block corners [k0, m0, k1, m1]: the city's own corridor
 * (TRACKS.train.corridor, lines 4 and 12 of both axes) when every segment of its four sides has a sidewalk, else the
 * largest rectangle at least TRANSIT.loopMin blocks a side whose sides all have one (the squarer of two of one area,
 * then the wider, then the first in row order). Null when the window has none: a window mostly over the lake.
 */
export function trainRectangle(g: StreetGrid): [number, number, number, number] | null {
  const B = g.blocks, [lo, hi] = TRACKS.train.corridor
  if (hi <= B && walkableRectangle(g, lo, lo, hi, hi)) return [lo, lo, hi, hi]
  const sizes: [number, number][] = []
  for (let w = TRANSIT.loopMin; w <= B; w++) for (let d = TRANSIT.loopMin; d <= B; d++) sizes.push([w, d])
  sizes.sort((a, b) => b[0] * b[1] - a[0] * a[1] || Math.abs(a[0] - a[1]) - Math.abs(b[0] - b[1]) || b[0] - a[0])
  for (const [w, d] of sizes) {
    for (let m0 = 0; m0 + d <= B; m0++) for (let k0 = 0; k0 + w <= B; k0++) if (walkableRectangle(g, k0, m0, k0 + w, m0 + d)) return [k0, m0, k0 + w, m0 + d]
  }
  return null
}

/**
 * The window's elevated loop (tracks.ts trainLoop: the deck, the arcs, the four mid-side stations) round trainRectangle,
 * its corners in absolute block indices (the window's origin is on the pitch). Null when the window has no rectangle.
 */
export function windowTrainLoop(g: StreetGrid): Track | null {
  const r = trainRectangle(g)
  if (!r) return null
  const kx = g.originX / P, mz = g.originZ / P
  const [k0, m0, k1, m1] = r
  return trainLoop([[k0 + kx, m0 + mz], [k1 + kx, m0 + mz], [k1 + kx, m1 + mz], [k0 + kx, m1 + mz]])
}

// ---------------------------------------------------------------- the corridors

/** The window's drone cells, as window block corners [k0, m0, k1, m1]: TRACKS.drone.faceBlocks a side, every side segment with a sidewalk. */
export function droneCells(g: StreetGrid): [number, number, number, number][] {
  const n = TRACKS.drone.faceBlocks, cells = Math.floor(g.blocks / n)
  const out: [number, number, number, number][] = []
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    const k0 = i * n, m0 = j * n
    if (walkableRectangle(g, k0, m0, k0 + n, m0 + n)) out.push([k0, m0, k0 + n, m0 + n])
  }
  return out
}

/**
 * The window's drone corridors, as the city's (tracks.ts droneCorridors): the face ring of every cell of droneCells,
 * clockwise on the right-hand lane at the first altitude, the same lane points counter-clockwise at the second; every
 * (segment, direction) belongs to one corridor of a family, so no two corridors share a point.
 */
export function windowDroneCorridors(g: StreetGrid): Track[] {
  const { altitude, laneOffset } = TRACKS.drone
  const kx = g.originX / P, mz = g.originZ / P
  const corners: Vec2[][] = droneCells(g).map(([k0, m0, k1, m1]) => [[k0 + kx, m0 + mz], [k1 + kx, m0 + mz], [k1 + kx, m1 + mz], [k0 + kx, m1 + mz]])
  const cw = corners.map((c, id) => ring(c, altitude[0], laneOffset, 'drone', id))
  const ccw = corners.map((c, id) => ring(c.slice().reverse(), altitude[1], -laneOffset, 'drone', cw.length + id))
  return [...cw, ...ccw]
}

/** The boxes among `boxes` the racetrack must keep clear of: those that reach into its envelope (TRACKS.plane.altitude − halfHeight). */
export const needlesOf = (boxes: readonly Box[]): Box[] => boxes.filter((b) => b[4] > TRACKS.plane.altitude - TRACKS.plane.halfHeight)

/** The racetrack's reach from its centre, m: along its straights (the half-size and a semicircle's radius) and across them. */
export const RACETRACK_REACH = Object.freeze({ along: TRACKS.plane.halfSize + TRACKS.plane.fillet, across: TRACKS.plane.fillet })

/**
 * The racetrack over the window (tracks.ts planeCorridors): about the window's middle, moved as little as needed to lie
 * inside `bounds` (the region's: a window by the region's edge would send the planes 1.8 km out over its margin,
 * where nothing is built) when the region is wide enough for it; or, when a needle among `boxes` (The Spire, 554 m)
 * comes within the envelope's half-length and TRANSIT.needleMargin of the track sampled every metre, about the nearest
 * middle a whole number of blocks away (held inside the bounds the same way) that clears every needle (rings of
 * TRANSIT.racetrackRings blocks, each ring in row order). Null when none within the rings does.
 */
export function windowPlaneCorridor(g: StreetGrid, boxes: readonly Box[] = [], bounds: Rect | null = null): Track | null {
  const needles = needlesOf(boxes)
  const room = TRACKS.plane.halfLength + TRANSIT.needleMargin
  const held = (x: number, z: number): Vec2 => {
    if (!bounds) return [x, z]
    const { along, across } = RACETRACK_REACH
    const fit = (v: number, lo: number, hi: number, reach: number): number => (hi - lo < 2 * reach ? (lo + hi) / 2 : Math.min(Math.max(v, lo + reach), hi - reach))
    return [fit(x, bounds.x0, bounds.x1, along), fit(z, bounds.z0, bounds.z1, across)]
  }
  const [cx, cz] = held(...windowCentre(g))
  const clear = (t: Track): boolean => {
    for (let s = 0; s < t.length; s += 1) {
      const q = poseAt(t, s)
      for (const b of needles) if (boxGap(q.x, q.z, b) < room) return false
    }
    return true
  }
  const first = planeCorridors([cx, cz])[0]
  if (needles.length === 0 || clear(first)) return first
  for (let r = 1; r <= TRANSIT.racetrackRings; r++) {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
      const t = planeCorridors(held(cx + dx * P, cz + dz * P))[0]
      if (clear(t)) return t
    }
  }
  return null
}

/** The city's VTOL cells (tracks.ts VTOL_CELLS) moved to the window's origin: block rectangles [k0, k1) × [m0, m1) in absolute block indices. */
export function windowVtolCells(g: StreetGrid): VtolCells {
  const kx = g.originX / P, mz = g.originZ / P
  return VTOL_CELLS.map((route) => route.map(([k0, k1, m0, m1]) => [k0 + kx, k1 + kx, m0 + mz, m1 + mz] as const))
}

/**
 * A region's second band of pads (tracks.ts VtolBand): the roofs over the city's 60 m ceiling that a generated map has
 * (its towers stand 60 to 140 m, its houses 10: almost no roof lies in the city's 24 to 60 m band), flown between at
 * 150 and 160 m: the tallest pad plus the envelope's half-height and clearance (140 + 1.5 + 8 = 149.5) stays under the
 * lower cruise, both cruises lie over the drones' 46 m and under the planes' 400 m, and a route's legs clear every
 * taller box (The Spire) as the city's do (tracks.ts legClear). The floor is the city's ceiling, so no roof is in both.
 */
export const HIGH_BAND: VtolBand = Object.freeze({ floor: TRACKS.vtol.ceiling, ceiling: 140, cruise: Object.freeze([150, 160] as const) })

/**
 * Four cells for a band's pads from where they stand, as block rectangles on the pitch (tracks.ts vtolRoutes reads a
 * cell in blocks): the pads' extent cut into quarters at the median of each axis (the block line under the upper
 * middle pad), in loop order round the middle, when every quarter holds a pad; else into four strips across its longer
 * axis at the blocks of the pads at its quartiles. The city's cells are the quarters of its downtown; a generated map's towers
 * stand round a hub, a three- or four-block square, so cells cut where the towers are find a loop where the city's
 * quarters find none. Null with fewer than four pads, or when neither cut leaves every cell a pad.
 */
export function padCells(pads: readonly Pad[]): readonly (readonly [number, number, number, number])[] | null {
  if (pads.length < 4) return null
  const blk = (v: number): number => Math.floor(v / P)
  const xs = pads.map((p) => p.x), zs = pads.map((p) => p.z)
  const k0 = blk(Math.min(...xs)), k1 = blk(Math.max(...xs)) + 1, m0 = blk(Math.min(...zs)), m1 = blk(Math.max(...zs)) + 1
  const has = (c: readonly [number, number, number, number]): boolean => pads.some((p) => p.x >= c[0] * P && p.x < c[1] * P && p.z >= c[2] * P && p.z < c[3] * P)
  /** The block line under the upper middle value: a cut there parts the pads as evenly as their blocks allow. */
  const median = (vs: readonly number[]): number => { const o = vs.slice().sort((a, b) => a - b); return blk(o[Math.floor(o.length / 2)]) }
  const ck = median(xs), cm = median(zs)
  const quarters: (readonly [number, number, number, number])[] = [[k0, ck, m0, cm], [ck, k1, m0, cm], [ck, k1, cm, m1], [k0, ck, cm, m1]]
  if (quarters.every(has)) return quarters
  const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...zs) - Math.min(...zs)
  const at = (p: Pad): number => (alongX ? p.x : p.z)
  const o = pads.slice().sort((a, b) => at(a) - at(b)), n = o.length
  const cuts = [1, 2, 3].map((q) => blk(at(o[Math.floor((q * n) / 4)])))
  const edges = alongX ? [k0, ...cuts, k1] : [m0, ...cuts, m1]
  const strips = edges.slice(0, 4).map((e, i): readonly [number, number, number, number] => (alongX ? [e, edges[i + 1], m0, m1] : [k0, k1, e, edges[i + 1]]))
  return strips.every(has) ? strips : null
}

/**
 * The window's VTOL routes: the city's two (its cells moved to the window, its band of roofs) where the window's roofs
 * give them, then up to two more over the region's towers (HIGH_BAND, cells by the pads: padCells), each a loop of four
 * pads whose every leg is clear (tracks.ts vtolRoutes). A window with no such roofs has none: that is legal.
 */
export function windowVtolRoutes(g: StreetGrid, boxes: readonly Box[]): Track[] {
  const low = vtolRoutes(boxes, windowVtolCells(g))
  const cells = padCells(vtolPads(boxes, HIGH_BAND))
  const high = cells ? vtolRoutes(boxes, [cells, cells], HIGH_BAND) : []
  return [...low, ...high]
}

// ---------------------------------------------------------------- the network and its boxes

/**
 * The craft boxes of a region, as the physics worker and the page both take them (SimInit.craftBoxes): every rectangular
 * building (clip.ts isRect: every generated footprint) standing on a lot of the window or of the one ring of lots round
 * it, as [x0, 0, z0, x1, height, z1] in engine metres (its roof may take a VTOL pad, its box bounds every leg); every
 * building anywhere that reaches into the racetrack's envelope (needlesOf: The Spire), by its footprint's box; and the
 * region's own plan (the rooms' boxes, the pier). From the hollowed pack (regionWorld.ts hollowLots), so a building put
 * out of sight (height 0) is no pad. In the pack's order, then the plan's: the same inputs give the same list.
 */
export function craftBoxesOf(pack: Pick<RegionPack, 'buildings'>, offset: { x: number; z: number }, g: StreetGrid, plan: readonly Box[] = []): Box[] {
  const B = g.blocks, K0 = g.originX / P, M0 = g.originZ / P
  const needle = TRACKS.plane.altitude - TRACKS.plane.halfHeight
  const out: Box[] = []
  for (let i = 0; i < polygonCount(pack.buildings); i++) {
    const h = pack.buildings.height[i] / DM
    if (!(h > 0)) continue
    const rings = polygonAt(pack.buildings, i)
    const at = buildingLot(pack, offset, i)
    const onWindow = at !== null && at.K >= K0 - 1 && at.K <= K0 + B && at.M >= M0 - 1 && at.M <= M0 + B
    if (at && onWindow && rings.length === 1 && isRect(rings[0])) out.push([at.b.x0, 0, at.b.z0, at.b.x1, h, at.b.z1])
    else if (h > needle && rings[0]?.length >= 3) {
      const xs = rings[0].map((p) => p[0] + offset.x), zs = rings[0].map((p) => p[1] + offset.z)
      out.push([Math.min(...xs), 0, Math.min(...zs), Math.max(...xs), h, Math.max(...zs)])
    }
  }
  for (const b of plan) out.push([b[0], b[1], b[2], b[3], b[4], b[5]])
  return out
}

/**
 * The window's whole track network, in the realm's order (tracks.ts buildTrackNetwork): the car rings of streetLoops,
 * then the elevated loop, the drone corridors, the racetrack (held inside `bounds`, the region's, when given) and the
 * VTOL routes between the roofs of `craftBoxes` (none without boxes, fewer when no clear loop of pads is found), ids
 * 0..n−1. Pure in its four arguments: the worker and the page build it apart and get the same tracks.
 */
export function windowNetwork(seed: number, g: StreetGrid, craftBoxes: readonly Box[] = [], bounds: Rect | null = null): TrackNetwork {
  const loop = windowTrainLoop(g)
  const plane = windowPlaneCorridor(g, craftBoxes, bounds)
  const all = [...streetLoops(seed, g), ...(loop ? [loop] : []), ...windowDroneCorridors(g), ...(plane ? [plane] : []), ...windowVtolRoutes(g, craftBoxes)]
  return Object.freeze({ seed, tracks: Object.freeze(all.map((t, id) => (t.id === id ? t : Object.freeze({ ...t, id })))) })
}

// ---------------------------------------------------------------- the crossings

/** One zebra crossing: the intersection it belongs to, the arm's direction, the carriageway's half-width it spans, and its stripes (engine metres). */
export interface Crosswalk { x: number; z: number; dir: Pt; half: number; stripes: Rect[] }

/** The half-width of a pedestrian street's carriageway (fromMacro.ts roadOf: a one-lane local road), m. */
export const WALK_STREET_HALF = roadWidth(ROAD_CLASS.local, 1).carriage / 2

/**
 * The zebra crossings of the window: at every node where two or more street arms with a sidewalk meet (a dead end and
 * a street's end are no intersection), one crossing on each such arm, in the band TRAFFIC.crosswalk along the arm from
 * the node's centre, across the carriageway (the window's road half-width on a car street, WALK_STREET_HALF on a
 * pedestrian one): stripes TRANSIT.crosswalk.stripe wide every `pitch`, centred, the kerbs kept `inset` clear: six on a
 * car street, three on a pedestrian one. The procedural city's own crossings are the ground shader's.
 */
export function crosswalks(g: StreetGrid): Crosswalk[] {
  const { stripe, pitch, inset } = TRANSIT.crosswalk
  const [near, far] = TRAFFIC.crosswalk
  const out: Crosswalk[] = []
  const B = g.blocks
  for (let m = 0; m <= B; m++) {
    for (let k = 0; k <= B; k++) {
      const arms: { bits: number; dir: Pt }[] = ([
        { bits: hSeg(g, k, m), dir: [1, 0] as Pt }, { bits: hSeg(g, k - 1, m), dir: [-1, 0] as Pt },
        { bits: vSeg(g, k, m), dir: [0, 1] as Pt }, { bits: vSeg(g, k, m - 1), dir: [0, -1] as Pt },
      ]).filter((a) => walk(a.bits))
      if (arms.length < 2) continue
      const x = g.originX + k * P, z = g.originZ + m * P
      for (const { bits, dir } of arms) {
        const half = drive(bits) ? g.roadHalf : WALK_STREET_HALF
        const n = Math.floor((2 * (half - inset)) / pitch + 1e-9)
        const stripes: Rect[] = []
        for (let i = 0; i < n; i++) {
          const off = (i - (n - 1) / 2) * pitch
          const c0 = off - stripe / 2, c1 = off + stripe / 2
          stripes.push(dir[0] !== 0 ? rect(x + dir[0] * near, z + c0, x + dir[0] * far, z + c1) : rect(x + c0, z + dir[1] * near, x + c1, z + dir[1] * far))
        }
        out.push({ x, z, dir, half, stripes })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- the shore and the roads

/** A segment and its half-width: a road's ribbon, or an opening to cut through the shore walls (regionWorld.ts regionPhysics). */
export interface Crossing { a: Pt; b: Pt; half: number }

interface RoadSegment extends Crossing { along: Pt }

/** Every road's segments (not a ferry's) in engine metres, each with the ribbon's half-width: the carriageway and, where it has them, the sidewalks. */
function roadSegments(pack: RegionPack, l: Layout): RoadSegment[] {
  const out: RoadSegment[] = []
  for (let i = 0; i < pack.roads.cls.length; i++) {
    const cls = pack.roads.cls[i]
    if (cls === ROAD_CLASS.ferry) continue
    const { carriage, sidewalk } = roadWidth(cls, pack.roads.lanes[i])
    const half = carriage / 2 + (sidewalk ? SIDEWALK : 0)
    const pts = shift(l, roadAt(pack, i))
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (len < 1e-6) continue
      out.push({ a, b, half, along: [(b[0] - a[0]) / len, (b[1] - a[1]) / len] })
    }
  }
  return out
}

/** The footprint boxes (outer ring) of every building of height, engine metres. */
function buildingRects(pack: RegionPack, l: Layout): Rect[] {
  const out: Rect[] = []
  for (let i = 0; i < polygonCount(pack.buildings); i++) {
    if (!(pack.buildings.height[i] / DM > 0)) continue
    const outer = shift(l, polygonAt(pack.buildings, i)[0] ?? [])
    if (outer.length < 3) continue
    out.push(bbox(outer))
  }
  return out
}

const bbox = (pts: readonly Pt[]): Rect => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z) }
  return { x0, z0, x1, z1 }
}

/** Every ring of every water polygon, engine metres. */
const waterRings = (pack: RegionPack, l: Layout): Pt[][] => {
  const out: Pt[][] = []
  for (let i = 0; i < polygonCount(pack.water); i++) for (const r of polygonAt(pack.water, i)) out.push(shift(l, r))
  return out
}

const pointIn = (x: number, z: number, ring: readonly Pt[]): boolean => {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c
  }
  return c
}

/** Distance from a point to a segment. */
function pointSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz)
}

/** Whether two segments cross (or touch). */
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt): number => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b)
  if (o1 !== o2 && o3 !== o4) return true
  const on = (p: Pt, q: Pt, r: Pt): boolean => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1])
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b))
}

/** Distance from a segment to a rectangle: 0 where they meet. */
function segmentRect(a: Pt, b: Pt, r: Rect): number {
  const inR = (p: Pt) => p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.z0 && p[1] <= r.z1
  if (inR(a) || inR(b)) return 0
  const c: Pt[] = [[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]]
  let best = Infinity
  for (let i = 0; i < 4; i++) {
    const p = c[i], q = c[(i + 1) % 4]
    if (segmentsCross(a, b, p, q)) return 0
    best = Math.min(best, pointSegment(a, p, q), pointSegment(b, p, q), pointSegment(p, a, b), pointSegment(q, a, b))
  }
  return best
}

/** Rectangles hashed by cells of `cell` metres, for overlap queries. */
class RectHash {
  private readonly cells = new Map<string, Rect[]>()
  private readonly cell: number
  constructor(cell: number) { this.cell = cell }
  add(r: Rect): void {
    for (let i = Math.floor(r.x0 / this.cell); i <= Math.floor(r.x1 / this.cell); i++) {
      for (let j = Math.floor(r.z0 / this.cell); j <= Math.floor(r.z1 / this.cell); j++) {
        const k = `${i},${j}`
        const list = this.cells.get(k)
        if (list) list.push(r)
        else this.cells.set(k, [r])
      }
    }
  }
  any(r: Rect): boolean {
    for (let i = Math.floor(r.x0 / this.cell); i <= Math.floor(r.x1 / this.cell); i++) {
      for (let j = Math.floor(r.z0 / this.cell); j <= Math.floor(r.z1 / this.cell); j++) {
        for (const o of this.cells.get(`${i},${j}`) ?? []) if (overlaps(o, r)) return true
      }
    }
    return false
  }
}

// ---------------------------------------------------------------- the ferry dock

/** Where a ferry would come alongside: the berth platform's outer face, its centre, the heading out over the water, and the length of the face. */
export interface Berth { x: number; z: number; heading: number; length: number }

export interface FerryDock {
  /** The shore point the pier leaves the land at: on the lake's edge, where the shore wall is opened. */
  shore: Pt
  /** The unit normal out over the water, and the quay: how far out from the shore the deck begins (the shore street's outer sidewalk edge, or 0 at a bare shore). */
  normal: Pt
  quay: number
  /** Where the deck begins. */
  root: Pt
  berth: Berth
  /** The deck, the platform and the railings: boxes the city's renderer draws and the physics worker walls (STYLE.deck, STYLE.rail). */
  boxes: Building[]
  /** The opening through the shore walls along the pier, the deck's half-width each side (regionWorld.ts regionPhysics). */
  opening: Crossing
}

/** The points of a rectangle's outline every `every` metres and its centre, for point-in-water checks. */
function outline(e: Pt, n: Pt, t: Pt, a0: number, a1: number, w0: number, w1: number, every: number): Pt[] {
  const at = (a: number, w: number): Pt => [e[0] + n[0] * a + t[0] * w, e[1] + n[1] * a + t[1] * w]
  const out: Pt[] = [at((a0 + a1) / 2, (w0 + w1) / 2)]
  for (let a = a0; a <= a1 + 1e-9; a = Math.min(a1, a + every)) {
    out.push(at(a, w0), at(a, w1))
    if (a >= a1) break
  }
  for (let w = w0; w <= w1 + 1e-9; w = Math.min(w1, w + every)) {
    out.push(at(a0, w), at(a1, w))
    if (w >= w1) break
  }
  return out
}

/** The axis-aligned rectangle spanned from `e` along `n` by a0..a1 and along `t` by w0..w1. */
const span = (e: Pt, n: Pt, t: Pt, a0: number, a1: number, w0: number, w1: number): Rect =>
  bbox([[e[0] + n[0] * a0 + t[0] * w0, e[1] + n[1] * a0 + t[1] * w0], [e[0] + n[0] * a1 + t[0] * w1, e[1] + n[1] * a1 + t[1] * w1]])

/**
 * The ferry dock of a region: a pier from the lake's shore nearest the window's middle out over the water. The shore
 * points tried lie every TRANSIT.pier.step m along every edge of a water polygon along an axis that has land on one
 * side and water on the other (not an edge along the region's box, not one between two rows of the lake), nearest the
 * window first; at each, the pier's axis is the edge's normal toward the water, and the deck begins at the quay: the
 * outer sidewalk edge of a street running along the shore within TRANSIT.pier.quayReach (every shore of a generated
 * map has one), or the shore itself. A point is kept when the deck (TRANSIT.pier.length by 2 · halfWidth) and the
 * berth platform at its end lie inside the region, over the water throughout, clear of every building by a metre and of
 * every road but the quay's own (a bridge over the lake would cross the pier). The pier is boxes: the deck and the
 * platform TRANSIT.pier.deck high (a step the avatar takes), railings from the shore wall's line to the platform along
 * both sides, round the platform's three outer sides and back along its two inner edges, so from the opening in the
 * wall (the deck's width) nothing leads onto the water plane. The berth is the platform's outer face; no ferry sails
 * yet. Null when no shore point serves (a region with no lake).
 */
export function ferryDock(pack: RegionPack, l: Layout, g: StreetGrid): FerryDock | null {
  const { halfWidth, length, deck, rail, railThickness, platform, berth, step, quayReach } = TRANSIT.pier
  const b = l.bounds
  const water = waterRings(pack, l)
  if (water.length === 0) return null
  const inWaterAt = (x: number, z: number): boolean => { let c = false; for (const r of water) if (pointIn(x, z, r)) c = !c; return c }
  // A point on an edge between two rows of the lake lies in both and so, by even-odd, in neither: a hair either way settles it.
  const inWater = (x: number, z: number): boolean => inWaterAt(x, z) || inWaterAt(x + 1e-3, z + 1e-3) || inWaterAt(x - 1e-3, z - 1e-3)
  const roads = roadSegments(pack, l)
  const buildings = buildingRects(pack, l)
  const [wx, wz] = windowCentre(g)
  const alongBox = (p: Pt, q: Pt) => (Math.abs(p[0] - b.x0) < 0.2 && Math.abs(q[0] - b.x0) < 0.2) || (Math.abs(p[0] - b.x1) < 0.2 && Math.abs(q[0] - b.x1) < 0.2) ||
    (Math.abs(p[1] - b.z0) < 0.2 && Math.abs(q[1] - b.z0) < 0.2) || (Math.abs(p[1] - b.z1) < 0.2 && Math.abs(q[1] - b.z1) < 0.2)
  const candidates: { e: Pt; n: Pt; d: number }[] = []
  for (const r of water) {
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length]
      const dx = q[0] - p[0], dz = q[1] - p[1], len = Math.hypot(dx, dz)
      if (len < 2 * halfWidth || (Math.abs(dx) > 1e-6 && Math.abs(dz) > 1e-6) || alongBox(p, q)) continue
      const t: Pt = [dx / len, dz / len], n: Pt = [-t[1], t[0]]
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2
      const plus = inWaterAt(mx + n[0], mz + n[1]), minus = inWaterAt(mx - n[0], mz - n[1])
      if (plus === minus) continue
      const out: Pt = plus ? n : [-n[0], -n[1]]
      for (let s = halfWidth; s <= len - halfWidth + 1e-6; s += step) {
        const e: Pt = [p[0] + t[0] * s, p[1] + t[1] * s]
        candidates.push({ e, n: out, d: Math.hypot(e[0] - wx, e[1] - wz) })
      }
    }
  }
  candidates.sort((a, c) => a.d - c.d || a.e[0] - c.e[0] || a.e[1] - c.e[1])
  for (const { e, n } of candidates) {
    const t: Pt = [-n[1], n[0]]
    const alongShore = (r: RoadSegment): boolean => Math.abs(r.along[0] * n[0] + r.along[1] * n[1]) < 1e-6
    const offset = (r: RoadSegment): number => (r.a[0] - e[0]) * n[0] + (r.a[1] - e[1]) * n[1]
    const quayRoad = (r: RoadSegment): boolean => {
      if (!alongShore(r) || Math.abs(offset(r)) > quayReach) return false
      const rx = r.b[0] - r.a[0], rz = r.b[1] - r.a[1]
      const along = ((e[0] - r.a[0]) * rx + (e[1] - r.a[1]) * rz) / (rx * rx + rz * rz)
      return along >= -1e-9 && along <= 1 + 1e-9
    }
    let quay = 0
    for (const r of roads) if (quayRoad(r)) quay = Math.max(quay, offset(r) + r.half)
    const end = quay + length + platform.length
    const deckRect = span(e, n, t, quay, quay + length, -halfWidth, halfWidth)
    const platRect = span(e, n, t, quay + length, end, -platform.halfWidth, platform.halfWidth)
    if (!inside(deckRect, b, 2) || !inside(platRect, b, 2)) continue
    const over = [...outline(e, n, t, quay + 0.01, quay + length - 0.01, -halfWidth + 0.01, halfWidth - 0.01, 7), ...outline(e, n, t, quay + length + 0.01, end - 0.01, -platform.halfWidth + 0.01, platform.halfWidth - 0.01, 7)]
    if (!over.every(([x, z]) => inWater(x, z))) continue
    if (buildings.some((r) => overlaps(grow(r, 1), deckRect) || overlaps(grow(r, 1), platRect))) continue
    if (roads.some((r) => !(alongShore(r) && Math.abs(offset(r)) <= quayReach) && (segmentRect(r.a, r.b, deckRect) < r.half + 1 || segmentRect(r.a, r.b, platRect) < r.half + 1))) continue
    const boxes: Building[] = []
    const box = (a0: number, a1: number, w0: number, w1: number, y0: number, y1: number, style: number) => {
      const r = span(e, n, t, a0, a1, w0, w1)
      boxes.push({ box: [r.x0, y0, r.z0, r.x1, y1, r.z1], style })
    }
    const top = deck + rail
    box(quay, quay + length, -halfWidth, halfWidth, 0, deck, STYLE.deck)
    box(quay + length, end, -platform.halfWidth, platform.halfWidth, 0, deck, STYLE.deck)
    for (const s of [-1, 1]) {
      const outer = s * halfWidth, inner = s * (halfWidth - railThickness)
      box(0, quay + length, Math.min(outer, inner), Math.max(outer, inner), 0, top, STYLE.rail)
      const pOuter = s * platform.halfWidth, pInner = s * (platform.halfWidth - railThickness)
      box(quay + length, end, Math.min(pOuter, pInner), Math.max(pOuter, pInner), 0, top, STYLE.rail)
      box(quay + length, quay + length + railThickness, Math.min(outer, pOuter), Math.max(outer, pOuter), 0, top, STYLE.rail)
    }
    box(end - railThickness, end, -platform.halfWidth, platform.halfWidth, 0, top, STYLE.rail)
    const tip: Pt = [e[0] + n[0] * end, e[1] + n[1] * end]
    return {
      shore: e, normal: n, quay, root: [e[0] + n[0] * quay, e[1] + n[1] * quay],
      berth: { x: tip[0], z: tip[1], heading: Math.atan2(n[0], n[1]), length: berth },
      boxes,
      opening: { a: [e[0] - n[0], e[1] - n[1]], b: tip, half: halfWidth },
    }
  }
  return null
}

/** The ferry berth of a region: where the pier's platform faces the open water (ferryDock), or null without a dock. */
export function ferryBerth(g: StreetGrid, pack: RegionPack, l: Layout): Berth | null {
  return ferryDock(pack, l, g)?.berth ?? null
}

// ---------------------------------------------------------------- the STOL strip

export interface StolStrip {
  /** The strip's centre, engine metres, its heading (tracks.ts convention: forward is (sin h, cos h)), and its size. */
  x: number
  z: number
  heading: number
  length: number
  width: number
  /** The paved rectangle, and its centreline from end to end with the paving's half-width (regionWorld.ts lays a ribbon on it). */
  rect: Rect
  paving: Crossing
  /** The threshold bars and the centreline dashes, rectangles the renderer paints at SURFACE.marking. */
  markings: Rect[]
}

/** The strip's markings about (x, z), along x or along z: TRANSIT.strip.threshold bars at both ends and the centreline's dashes between. */
export function stripMarkings(x: number, z: number, alongX: boolean): Rect[] {
  const { length, threshold, centreline } = TRANSIT.strip
  const hl = length / 2
  const local = (a0: number, a1: number, w0: number, w1: number): Rect => (alongX ? rect(x + a0, z + w0, x + a1, z + w1) : rect(x + w0, z + a0, x + w1, z + a1))
  const out: Rect[] = []
  for (const end of [-1, 1]) {
    for (const off of threshold.offsets) for (const side of [-1, 1]) {
      const w = side * off
      out.push(local(end * (hl - threshold.to), end * (hl - threshold.from), w - threshold.width / 2, w + threshold.width / 2))
    }
  }
  for (let a = -hl + centreline.from; a + centreline.on <= hl - centreline.from + 1e-9; a += centreline.on + centreline.off) {
    out.push(local(a, a + centreline.on, -centreline.width / 2, centreline.width / 2))
  }
  return out
}

/**
 * The STOL strip of a region: TRANSIT.strip.length by width, paved, on the open land nearest the window's middle. The
 * candidates are the centres of the map's blocks (the generated map's lots), nearest first, each along x and along z;
 * the first whose strip and its margin lie inside the region, off the window, and clear of every building's footprint,
 * every road's ribbon (the carriageway and the sidewalks), every water polygon and every plaza is taken. On a generated
 * map that is a ravine (no street crosses one between the arterials' bridges, 640 m apart): a grid of 40 m blocks has
 * no other 300 m without a street. Null when no block serves. Planes fly the racetrack at 400 m and do not land here.
 */
export function stolStrip(pack: RegionPack, l: Layout, g: StreetGrid): StolStrip | null {
  const { length, width, margin } = TRANSIT.strip
  const b = l.bounds
  const window: Rect = { x0: g.originX, z0: g.originZ, x1: g.originX + g.blocks * P, z1: g.originZ + g.blocks * P }
  const [wx, wz] = windowCentre(g)
  const hash = new RectHash(128)
  for (const r of buildingRects(pack, l)) hash.add(r)
  for (const r of roadSegments(pack, l)) hash.add(grow(bbox([r.a, r.b]), r.half))
  for (const r of waterRings(pack, l)) hash.add(bbox(r))
  if (pack.plazas) for (let i = 0; i < polygonCount(pack.plazas); i++) hash.add(bbox(shift(l, polygonAt(pack.plazas, i)[0] ?? [])))
  const candidates: { x: number; z: number; d: number }[] = []
  for (let m = Math.floor(b.z0 / P); (m + 0.5) * P < b.z1; m++) {
    for (let k = Math.floor(b.x0 / P); (k + 0.5) * P < b.x1; k++) {
      const x = (k + 0.5) * P, z = (m + 0.5) * P
      candidates.push({ x, z, d: Math.hypot(x - wx, z - wz) })
    }
  }
  candidates.sort((a, c) => a.d - c.d || a.x - c.x || a.z - c.z)
  const hl = length / 2, hw = width / 2
  for (const { x, z } of candidates) {
    for (const alongX of [false, true]) {
      const r: Rect = alongX ? { x0: x - hl, z0: z - hw, x1: x + hl, z1: z + hw } : { x0: x - hw, z0: z - hl, x1: x + hw, z1: z + hl }
      const kept = grow(r, margin)
      if (!inside(kept, b, 0) || overlaps(kept, window) || hash.any(kept)) continue
      const paving: Crossing = alongX ? { a: [x - hl, z], b: [x + hl, z], half: hw } : { a: [x, z - hl], b: [x, z + hl], half: hw }
      return { x, z, heading: alongX ? Math.PI / 2 : 0, length, width, rect: r, paving, markings: stripMarkings(x, z, alongX) }
    }
  }
  return null
}

// ---------------------------------------------------------------- all of it

/** What the page draws and the worker walls for a region's transit, besides the network: regionTransit. */
export interface RegionTransit {
  crosswalks: Crosswalk[]
  dock: FerryDock | null
  strip: StolStrip | null
  /** Every painted rectangle, engine metres: the zebras' stripes, the strip's bars and dashes (regionWorld.ts draws them at SURFACE.marking). */
  markings: Rect[]
  /** Boxes the city's renderer draws over the region and the physics worker walls: the pier's. */
  plan: Building[]
  /** Openings through the shore walls (regionWorld.ts regionPhysics): the pier's. */
  openings: Crossing[]
}

/** The transit of a region with a street window: its crossings, its dock and its strip, and what they add to the plan and the walls. */
export function regionTransit(pack: RegionPack, l: Layout, g: StreetGrid): RegionTransit {
  const walks = crosswalks(g)
  const dock = ferryDock(pack, l, g)
  const strip = stolStrip(pack, l, g)
  return {
    crosswalks: walks, dock, strip,
    markings: [...walks.flatMap((c) => c.stripes), ...(strip?.markings ?? [])],
    plan: dock ? dock.boxes : [],
    openings: dock ? [dock.opening] : [],
  }
}
