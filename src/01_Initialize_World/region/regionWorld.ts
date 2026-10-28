// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It turns a region pack (region/pack.ts) into what the page draws and what the physics
 * worker builds, in the engine's frame:
 * - the layout: where the region sits (away from the procedural grid the GPU crowd still walks, which is hidden in a
 *   region, so none of it can meet the region);
 * - the meshes: every building extruded from its surveyed footprint to its surveyed height, walls and roof, merged by
 *   tile and dressed by the city's own facade shader (its windows follow each wall, at any angle); roads and sidewalks
 *   as ribbons at their surveyed widths, with centre lines and lane dashes; water; the ground;
 * - the physics: every wall as a segment with its height, the lake's shoreline as a low wall, and the region's edge;
 * - places: the fictional name of the street you stand on and the nearest cross street, and a spawn on a sidewalk;
 * - the workplaces' lots hollowed (hollowLots): the buildings on the lots region/workplaces.ts chose are put out of
 *   sight and out of the walls, and the rooms (interiors.ts) stand there instead, as boxes the city's renderer and
 *   colliders take: the glass shell, the furniture, the ceiling slab in the podium's finish, and whatever stood above
 *   the slab carried on it; each room's floor is paved.
 * What breaks if it is removed? A region pack can be compiled but never walked.
 */
import {
  BufferGeometry, Float32BufferAttribute, Mesh, MeshStandardNodeMaterial, PlaneGeometry, ShapeUtils, Vector2, type Node, type UniformNode, type Vector4,
} from 'three/webgpu'
import { abs, attribute, float, fract, mix, positionWorld, smoothstep, step, vec3 } from 'three/tsl'
import { CITY, STYLE, type Building } from '../city.ts'
import type { FbmSet } from '../fbmTexture.ts'
import { ROOM, toWorld, workplacesAt, type Workplace, type WorkplaceLot } from '../interiors.ts'
import { buildingMaterial, waterMaterial } from '../materials.ts'
import { applyMatrixMode } from '../matrixMode.ts'
import { type Pt, type Rect } from './clip.ts'
import { BUILDING_KIND, DM, FLOW, ROAD_CLASS, WATER_KIND, polygonAt, polygonCount, roadAt, type RegionPack } from './pack.ts'
import { buildingLot, slabPodium, type LotBuilding } from './workplaces.ts'

type F = Node<'float'>

/** Where the region's south-west corner sits in the engine's frame: clear of the procedural grid (0..640 m). */
export const REGION_CORNER = Object.freeze({ x: 2000, z: 2000 })
/** Lane width, m, and the sidewalk each side of a street that has one. */
export const LANE_WIDTH = 3.3
export const SIDEWALK = 2.2
/** Height of the lake's shoreline wall and of the region's edge wall (physics only), m. */
export const SHORE_WALL = 1.2
export const EDGE_WALL = 4

export interface RegionLayout {
  /** Added to the pack's coordinates (metres) to get the engine's. */
  offset: { x: number; z: number }
  /** The region in the engine's frame. */
  bounds: Rect
  /** Ground paved as sidewalk besides the streets', in the engine's frame: the workplaces' floors (hollowLots). */
  floors?: Rect[]
}

export function layoutOf(pack: RegionPack): RegionLayout {
  const b = pack.bounds
  const offset = { x: Math.round(REGION_CORNER.x - b.x0), z: Math.round(REGION_CORNER.z - b.z0) }
  return { offset, bounds: { x0: b.x0 + offset.x, z0: b.z0 + offset.z, x1: b.x1 + offset.x, z1: b.z1 + offset.z } }
}

const shift = (l: RegionLayout, pts: readonly Pt[]): Pt[] => pts.map(([x, z]) => [x + l.offset.x, z + l.offset.z] as Pt)

/** The width of a road's carriageway, m, and whether it has sidewalks. */
export function roadWidth(cls: number, lanes: number): { carriage: number; sidewalk: boolean } {
  const carriage = Math.max(cls === ROAD_CLASS.lane ? 3.2 : 3.5, lanes * LANE_WIDTH)
  const sidewalk = cls === ROAD_CLASS.arterial || cls === ROAD_CLASS.collector || cls === ROAD_CLASS.local
  return { carriage, sidewalk }
}

// ---------------------------------------------------------------- physics

/** What the physics worker builds a region from: its bounds, and every wall as (x0, z0, x1, z1, height), m. */
export interface RegionPhysics {
  bounds: Rect
  walls: Float32Array
}

/** Twice the signed area of a ring in the standard (x, z) sense: positive counter-clockwise with z pointing up. */
const area2 = (r: readonly Pt[]): number => {
  let s = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]
  return s
}

export function regionPhysics(pack: RegionPack, l: RegionLayout): RegionPhysics {
  const w: number[] = []
  for (let i = 0; i < polygonCount(pack.buildings); i++) {
    const h = pack.buildings.height[i] / DM
    // A building of no height is one hollowLots put out of a room's way: it has no walls. No pack writes one.
    if (!(h > 0)) continue
    for (const ring of polygonAt(pack.buildings, i)) {
      const r = shift(l, ring)
      for (let k = 0; k < r.length; k++) {
        const a = r[k], b = r[(k + 1) % r.length]
        w.push(a[0], a[1], b[0], b[1], h)
      }
    }
  }
  // The lake's shoreline, but not where the region's edge cut it: an edge lying along one side of the box, and not
  // where a road crosses it (a bridge: the wall is cut for the road's whole width, carriageway and sidewalks).
  const b = l.bounds
  const alongBox = (p: Pt, q: Pt) => (Math.abs(p[0] - b.x0) < 0.2 && Math.abs(q[0] - b.x0) < 0.2) || (Math.abs(p[0] - b.x1) < 0.2 && Math.abs(q[0] - b.x1) < 0.2) ||
    (Math.abs(p[1] - b.z0) < 0.2 && Math.abs(q[1] - b.z0) < 0.2) || (Math.abs(p[1] - b.z1) < 0.2 && Math.abs(q[1] - b.z1) < 0.2)
  const bridges = roadCrossings(pack, l)
  for (let i = 0; i < polygonCount(pack.water); i++) {
    if (pack.water.kind[i] !== WATER_KIND.lake) continue
    for (const ring of polygonAt(pack.water, i)) {
      const r = shift(l, ring)
      for (let k = 0; k < r.length; k++) {
        const p = r[k], q = r[(k + 1) % r.length]
        if (alongBox(p, q)) continue
        for (const [a, c] of bridges.cut(p, q)) w.push(a[0], a[1], c[0], c[1], SHORE_WALL)
      }
    }
  }
  // The region's edge.
  const c: Pt[] = [[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]]
  for (let k = 0; k < 4; k++) w.push(c[k][0], c[k][1], c[(k + 1) % 4][0], c[(k + 1) % 4][1], EDGE_WALL)
  return { bounds: b, walls: new Float32Array(w) }
}

/**
 * Where roads cross a wall: the pieces of a wall segment left once every road that crosses or touches it has cut a gap
 * of its own width (regionWorld roadWidth: the carriageway and, where it has them, the sidewalks). A bridge over the
 * lake is a road across the shoreline; without the gap, a car driving it would hit the shore wall.
 */
function roadCrossings(pack: RegionPack, l: RegionLayout): { cut(p: Pt, q: Pt): [Pt, Pt][] } {
  const roads: { a: Pt; b: Pt; half: number }[] = []
  for (let i = 0; i < pack.roads.cls.length; i++) {
    const cls = pack.roads.cls[i]
    if (cls === ROAD_CLASS.ferry) continue
    const { carriage, sidewalk } = roadWidth(cls, pack.roads.lanes[i])
    const half = carriage / 2 + (sidewalk ? SIDEWALK : 0)
    const pts = shift(l, roadAt(pack, i))
    for (let k = 0; k + 1 < pts.length; k++) roads.push({ a: pts[k], b: pts[k + 1], half })
  }
  return {
    cut(p, q) {
      const dx = q[0] - p[0], dz = q[1] - p[1], len = Math.hypot(dx, dz)
      if (!(len > 1e-6)) return []
      const gaps: [number, number][] = []
      for (const { a, b, half } of roads) {
        // The two segments' crossing, as fractions along each; a road end on the wall (a bridge starting at the shore)
        // counts, as does a wall end on the road.
        const ex = b[0] - a[0], ez = b[1] - a[1]
        const den = dx * ez - dz * ex
        if (Math.abs(den) < 1e-9) continue
        const t = ((a[0] - p[0]) * ez - (a[1] - p[1]) * ex) / den
        const u = ((a[0] - p[0]) * dz - (a[1] - p[1]) * dx) / den
        const eps = 1e-6
        if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) continue
        // The gap along the wall: the road's half-width, widened by the crossing's slant.
        const cos = Math.abs(dx * ez - dz * ex) / (len * Math.hypot(ex, ez))
        const reach = half / Math.max(cos, 0.2) / len
        gaps.push([t - reach, t + reach])
      }
      if (gaps.length === 0) return [[p, q]]
      gaps.sort((g, h) => g[0] - h[0])
      const out: [Pt, Pt][] = []
      const at = (t: number): Pt => [p[0] + dx * t, p[1] + dz * t]
      let from = 0
      for (const [g0, g1] of gaps) {
        if (g0 > from && g0 - from > 0.05 / len) out.push([at(from), at(Math.min(g0, 1))])
        from = Math.max(from, g1)
        if (from >= 1) break
      }
      if (from < 1 && 1 - from > 0.05 / len) out.push([at(from), q])
      return out
    },
  }
}

// ---------------------------------------------------------------- places

/** A uniform grid of items by their bounding boxes, for nearest queries. */
class Grid2<T> {
  private readonly cells = new Map<number, T[]>()
  private readonly cell: number
  constructor(cell: number) {
    this.cell = cell
  }
  private key(cx: number, cz: number): number { return ((cx + 32768) & 0xffff) * 65536 + ((cz + 32768) & 0xffff) }
  add(item: T, x0: number, z0: number, x1: number, z1: number): void {
    for (let cx = Math.floor(x0 / this.cell); cx <= Math.floor(x1 / this.cell); cx++) {
      for (let cz = Math.floor(z0 / this.cell); cz <= Math.floor(z1 / this.cell); cz++) {
        const k = this.key(cx, cz)
        const list = this.cells.get(k)
        if (list) list.push(item)
        else this.cells.set(k, [item])
      }
    }
  }
  near(x: number, z: number, radius: number): Set<T> {
    const out = new Set<T>()
    for (let cx = Math.floor((x - radius) / this.cell); cx <= Math.floor((x + radius) / this.cell); cx++) {
      for (let cz = Math.floor((z - radius) / this.cell); cz <= Math.floor((z + radius) / this.cell); cz++) {
        for (const t of this.cells.get(this.key(cx, cz)) ?? []) out.add(t)
      }
    }
    return out
  }
}

const segDist = (x: number, z: number, a: Pt, b: Pt): number => {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz)
}

const pointIn = (x: number, z: number, ring: readonly Pt[]): boolean => {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c
  }
  return c
}

/** The region's places: the street under a point, the cross street, whether a point is inside a building, a spawn. */
export class RegionPlaces {
  private readonly roads = new Grid2<number>(50)
  private readonly buildings = new Grid2<number>(50)
  private readonly roadPts: Pt[][] = []
  private readonly rings: Pt[][] = []
  private readonly water: Pt[][][] = []
  private readonly pack: RegionPack

  constructor(pack: RegionPack, l: RegionLayout) {
    this.pack = pack
    for (let i = 0; i < polygonCount(pack.water); i++) this.water.push(polygonAt(pack.water, i).map((r) => shift(l, r)))
    for (let i = 0; i < pack.roads.cls.length; i++) {
      const pts = shift(l, roadAt(pack, i))
      this.roadPts.push(pts)
      if (pack.roads.cls[i] === ROAD_CLASS.ferry) continue
      const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1])
      this.roads.add(i, Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs))
    }
    for (let i = 0; i < polygonCount(pack.buildings); i++) {
      const outer = shift(l, polygonAt(pack.buildings, i)[0])
      this.rings.push(outer)
      const xs = outer.map((p) => p[0]), zs = outer.map((p) => p[1])
      this.buildings.add(i, Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs))
    }
  }

  /** The nearest road (not a ferry) within `radius`, and its distance. */
  nearestRoad(x: number, z: number, radius = 60, except?: number): { road: number; d: number } | null {
    let best: { road: number; d: number } | null = null
    for (const i of this.roads.near(x, z, radius)) {
      if (except !== undefined && this.pack.roads.name[i] === except) continue
      const pts = this.roadPts[i]
      for (let k = 0; k + 1 < pts.length; k++) {
        const d = segDist(x, z, pts[k], pts[k + 1])
        if (d <= radius && (!best || d < best.d)) best = { road: i, d }
      }
    }
    return best
  }

  /** "Street & Cross Street" where the point stands, or the region's name if no street is near. */
  place(x: number, z: number): string {
    const here = this.nearestRoad(x, z, 60)
    const names = this.pack.names
    if (!here || !names[this.pack.roads.name[here.road]]) return this.pack.name
    const n = this.pack.roads.name[here.road]
    const cross = this.nearestRoad(x, z, 90, n)
    const crossName = cross ? names[this.pack.roads.name[cross.road]] : ''
    return crossName ? `${names[n]} & ${crossName}` : names[n]
  }

  /**
   * The minimap's layer: water, then buildings, then streets (each at its carriageway width), within `radius` of (x, z),
   * drawn in the engine's metres on a context already transformed to them.
   */
  drawMap(ctx: CanvasRenderingContext2D, x: number, z: number, radius: number, dark: boolean): void {
    ctx.fillStyle = dark ? '#0c2a3a' : '#9cc9dd'
    for (const poly of this.water) {
      ctx.beginPath()
      for (const ring of poly) {
        ring.forEach(([px, pz], k) => (k ? ctx.lineTo(px, pz) : ctx.moveTo(px, pz)))
        ctx.closePath()
      }
      ctx.fill('evenodd')
    }
    ctx.fillStyle = dark ? '#1e293b' : '#cfd3d9'
    for (const i of this.buildings.near(x, z, radius)) {
      const r = this.rings[i]
      ctx.beginPath()
      r.forEach(([px, pz], k) => (k ? ctx.lineTo(px, pz) : ctx.moveTo(px, pz)))
      ctx.closePath()
      ctx.fill()
    }
    ctx.strokeStyle = dark ? '#334155' : '#ffffff'
    ctx.lineCap = 'round'
    for (const i of this.roads.near(x, z, radius)) {
      const pts = this.roadPts[i]
      ctx.lineWidth = roadWidth(this.pack.roads.cls[i], this.pack.roads.lanes[i]).carriage
      ctx.beginPath()
      pts.forEach(([px, pz], k) => (k ? ctx.lineTo(px, pz) : ctx.moveTo(px, pz)))
      ctx.stroke()
    }
  }

  inBuilding(x: number, z: number, pad = 0): boolean {
    for (const i of this.buildings.near(x, z, pad + 1)) {
      const r = this.rings[i]
      if (pointIn(x, z, r)) return true
      if (pad > 0) for (let k = 0; k < r.length; k++) if (segDist(x, z, r[k], r[(k + 1) % r.length]) < pad) return true
    }
    return false
  }

  /**
   * A place to stand: on the sidewalk of the arterial nearest `near` (the region's centre by default), clear of every
   * building by a metre, facing along the street.
   */
  spawn(near: { x: number; z: number }): { x: number; z: number; heading: number } {
    const order = this.roadPts.map((pts, i) => ({ i, d: Math.min(...pts.map((p) => Math.hypot(p[0] - near.x, p[1] - near.z))) }))
      .filter(({ i }) => this.pack.roads.cls[i] === ROAD_CLASS.arterial)
      .sort((a, b) => a.d - b.d)
    for (const { i } of order.slice(0, 200)) {
      const pts = this.roadPts[i]
      const { carriage } = roadWidth(this.pack.roads.cls[i], this.pack.roads.lanes[i])
      for (let k = 0; k + 1 < pts.length; k++) {
        const [a, b] = [pts[k], pts[k + 1]]
        const len = Math.hypot(b[0] - a[0], b[1] - a[1])
        if (len < 8) continue
        const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len
        for (const side of [1, -1]) {
          const off = carriage / 2 + SIDEWALK / 2
          const x = (a[0] + b[0]) / 2 - uz * off * side, z = (a[1] + b[1]) / 2 + ux * off * side
          if (!this.inBuilding(x, z, 1)) return { x, z, heading: Math.atan2(ux, uz) }
        }
      }
    }
    return { x: near.x, z: near.z, heading: 0 }
  }
}

// ---------------------------------------------------------------- meshes

/** A dark, fine-grained asphalt with a yellow centre line on two-way streets and dashed white lines between lanes. */
function asphaltMaterial(fbm: FbmSet): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial()
  const p = positionWorld
  const across = attribute('across', 'float') as unknown as F // −1 … 1 over the carriageway
  const dist = attribute('dist', 'float') as unknown as F // m along the road
  const lanes = attribute('lanes', 'float') as unknown as F
  const twoWay = attribute('twoWay', 'float') as unknown as F
  const halfW = attribute('halfWidth', 'float') as unknown as F
  const n = fbm.sample(p.xz.div(3)).r
  const base = mix(vec3(0.07, 0.07, 0.075), vec3(0.11, 0.11, 0.115), n)
  const x = across.mul(halfW) // m from the centreline
  // Centre: a double yellow on two-way streets of two lanes or more.
  const centre = step(abs(abs(x).sub(0.12)), 0.06).mul(twoWay).mul(step(1.5, lanes))
  // Lane dashes: 3 m of paint every 9 m, between lanes of the same direction.
  const laneW = halfW.mul(2).div(lanes.max(1))
  const k = x.add(halfW).div(laneW)
  const nearDivider = step(abs(k.sub(k.round())), float(0.07).div(laneW)).mul(step(0.5, k.round())).mul(step(k.round(), lanes.sub(0.5)))
  const isCentre = step(abs(k.round().sub(lanes.div(2))), 0.01).mul(twoWay)
  const dash = step(fract(dist.div(9)), 0.33).mul(nearDivider).mul(float(1).sub(isCentre)).mul(step(2.5, lanes))
  const edge = step(float(1).sub(float(0.15).div(halfW)), abs(across)).mul(step(1.5, lanes))
  m.colorNode = mix(mix(base, vec3(0.78, 0.6, 0.12), centre), vec3(0.78, 0.78, 0.74), dash.add(edge).min(1))
  m.roughnessNode = float(0.88)
  m.polygonOffset = true
  m.polygonOffsetFactor = -2
  m.polygonOffsetUnits = -2
  return m
}

/** Concrete sidewalk slabs with joints every 1.5 m. */
function sidewalkMaterial(fbm: FbmSet): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial()
  const p = positionWorld
  const dist = attribute('dist', 'float') as unknown as F
  const n = fbm.sample(p.xz.div(2.5)).g
  const joint = smoothstep(0.96, 0.99, fract(dist.div(1.5)))
  m.colorNode = mix(vec3(0.5, 0.49, 0.46), vec3(0.58, 0.57, 0.54), n).mul(float(1).sub(joint.mul(0.3)))
  m.roughnessNode = float(0.9)
  m.polygonOffset = true
  m.polygonOffsetFactor = -1
  m.polygonOffsetUnits = -1
  return m
}

/** The ground between streets and buildings: lawns and bare earth. */
function groundMaterial(fbm: FbmSet): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial()
  const p = positionWorld
  const a = fbm.sample(p.xz.div(11)).r, b = fbm.sample(p.xz.div(1.7)).g
  const grass = mix(vec3(0.13, 0.2, 0.08), vec3(0.2, 0.27, 0.11), b)
  const earth = mix(vec3(0.24, 0.21, 0.17), vec3(0.3, 0.27, 0.22), b)
  m.colorNode = mix(grass, earth, smoothstep(0.55, 0.75, a))
  m.roughnessNode = float(0.95)
  return m
}

interface Buffers { pos: number[]; nor: number[]; idx: number[]; extra: Record<string, number[]> }
const buffers = (...extra: string[]): Buffers => ({ pos: [], nor: [], idx: [], extra: Object.fromEntries(extra.map((k) => [k, []])) })

function geometryOf(b: Buffers): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(b.pos, 3))
  g.setAttribute('normal', new Float32BufferAttribute(b.nor, 3))
  for (const [k, v] of Object.entries(b.extra)) g.setAttribute(k, new Float32BufferAttribute(v, 1))
  g.setIndex(b.idx)
  g.computeBoundingSphere()
  return g
}

/** A ribbon `half` wide each side of a polyline, at height y, mitred at its bends. Extra per-vertex values from `v`. */
function ribbon(b: Buffers, pts: readonly Pt[], half: number, y: number, v: (across: number, dist: number) => Record<string, number>): void {
  if (pts.length < 2) return
  let dist = 0
  const base = b.pos.length / 3
  for (let k = 0; k < pts.length; k++) {
    const prev = pts[Math.max(0, k - 1)], next = pts[Math.min(pts.length - 1, k + 1)]
    if (k > 0) dist += Math.hypot(pts[k][0] - prev[0], pts[k][1] - prev[1])
    let tx = next[0] - prev[0], tz = next[1] - prev[1]
    const tl = Math.hypot(tx, tz) || 1
    tx /= tl; tz /= tl
    // Miter: scale the normal so each side stays `half` from both segments, capped at twice.
    let scale = 1
    if (k > 0 && k < pts.length - 1) {
      const ax = pts[k][0] - prev[0], az = pts[k][1] - prev[1], al = Math.hypot(ax, az) || 1
      const cos = (ax / al) * tx + (az / al) * tz
      scale = Math.min(2, 1 / Math.max(0.5, cos))
    }
    const nx = -tz * half * scale, nz = tx * half * scale
    for (const side of [-1, 1]) {
      b.pos.push(pts[k][0] + nx * side, y, pts[k][1] + nz * side)
      b.nor.push(0, 1, 0)
      const e = v(side, dist)
      for (const key of Object.keys(b.extra)) b.extra[key].push(e[key] ?? 0)
    }
    if (k > 0) {
      const i = base + 2 * (k - 1)
      // Up-facing: (i, i+2, i+1) and (i+1, i+2, i+3) wind counter-clockwise seen from above for a left side at −1.
      b.idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2)
    }
  }
}

/** A building's finish: towers mixed, mid-rise stone or brick, the smallest sheds plain, places of worship stone. */
function styleOf(kind: number, height: number, area: number, seed: number): number {
  if (kind === BUILDING_KIND.worship) return STYLE.stone
  if (area < 40 && height < 6) return STYLE.concrete
  if (height > 30) return STYLE.mixed
  if (kind === BUILDING_KIND.school || kind === BUILDING_KIND.civic) return STYLE.brick
  return seed < 0.6 ? STYLE.brick : seed < 0.85 ? STYLE.stone : STYLE.condo
}

/** Building i's finish from its outer ring in the engine's frame: styleOf, with the index's own dice. */
const finishOf = (pack: RegionPack, i: number, outer: readonly Pt[]): number =>
  styleOf(pack.buildings.kind[i], pack.buildings.height[i] / DM, Math.abs(area2(outer)) / 2, ((i * 2654435761) >>> 0) / 2 ** 32)

/** Building i's finish, as its walls are drawn (a room's ceiling slab and what it carries take their building's). */
export function buildingStyle(pack: RegionPack, l: RegionLayout, i: number): number {
  return finishOf(pack, i, shift(l, polygonAt(pack.buildings, i)[0]))
}

/** Every building of the pack, merged by `tile`-metre tiles, walls and roofs, with the facade attributes. */
function buildingGeometries(pack: RegionPack, l: RegionLayout, tile: number): Map<string, BufferGeometry> {
  const tiles = new Map<string, Buffers>()
  for (let i = 0; i < polygonCount(pack.buildings); i++) {
    const h = pack.buildings.height[i] / DM
    // A building of no height is one hollowLots put out of sight: nothing to draw, and no tile opened for it.
    if (!(h > 0)) continue
    const rings = polygonAt(pack.buildings, i).map((r) => shift(l, r))
    const outer = rings[0]
    const key = `${Math.floor(outer[0][0] / tile)},${Math.floor(outer[0][1] / tile)}`
    let b = tiles.get(key)
    if (!b) tiles.set(key, (b = buffers('style', 'along')))
    const style = finishOf(pack, i, outer)
    // Walls: one quad per edge, facing out of the solid (holes face into the courtyard).
    rings.forEach((r, ri) => {
      // In (x, z) taken as a plane, a counter-clockwise ring (area2 > 0) has its inside on the left of every edge. A wall
      // faces away from the solid: out of an outer ring, into a courtyard.
      const ccw = area2(r) > 0
      const faceLeft = ri === 0 ? !ccw : ccw
      let along = 0
      for (let k = 0; k < r.length; k++) {
        const a = r[k], c = r[(k + 1) % r.length]
        const ex = c[0] - a[0], ez = c[1] - a[1], len = Math.hypot(ex, ez)
        if (len < 1e-3) continue
        // Left of the edge is (−ez, ex).
        let nx = -ez / len, nz = ex / len
        if (!faceLeft) { nx = -nx; nz = -nz }
        const base = b.pos.length / 3
        b.pos.push(a[0], 0, a[1], c[0], 0, c[1], c[0], h, c[1], a[0], h, a[1])
        for (let q = 0; q < 4; q++) { b.nor.push(nx, 0, nz); b.extra.style.push(style) }
        b.extra.along.push(along, along + len, along + len, along)
        along += len
        // The triangles (a0, c0, c1) and (a0, c1, a1) face left of the edge: (c − a) × (c1 − a) = h·(−ez, 0, ex).
        if (faceLeft) b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
        else b.idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
      }
    })
    // Roof.
    const contour = outer.map(([x, z]) => new Vector2(x, z))
    const holes = rings.slice(1).map((r) => r.map(([x, z]) => new Vector2(x, z)))
    const tris = ShapeUtils.triangulateShape(contour, holes)
    const all = [contour, ...holes].flat()
    const base = b.pos.length / 3
    for (const p of all) {
      b.pos.push(p.x, h, p.y)
      b.nor.push(0, 1, 0)
      b.extra.style.push(style)
      b.extra.along.push(p.x)
    }
    for (const [p0, p1, p2] of tris) {
      const a = all[p0], c = all[p1], d = all[p2]
      // Up-facing: the cross product's y is (c − a).z·(d − a).x − (c − a).x·(d − a).z > 0.
      const up = (c.y - a.y) * (d.x - a.x) - (c.x - a.x) * (d.y - a.y) > 0
      b.idx.push(base + p0, up ? base + p1 : base + p2, up ? base + p2 : base + p1)
    }
  }
  const out = new Map<string, BufferGeometry>()
  for (const [k, b] of tiles) out.set(k, geometryOf(b))
  return out
}

/** Water polygons triangulated, at height y. */
function waterGeometry(pack: RegionPack, l: RegionLayout, y: number): BufferGeometry {
  const b = buffers()
  for (let i = 0; i < polygonCount(pack.water); i++) {
    const rings = polygonAt(pack.water, i).map((r) => shift(l, r))
    const contour = rings[0].map(([x, z]) => new Vector2(x, z))
    const holes = rings.slice(1).map((r) => r.map(([x, z]) => new Vector2(x, z)))
    const tris = ShapeUtils.triangulateShape(contour, holes)
    const all = [contour, ...holes].flat()
    const base = b.pos.length / 3
    for (const p of all) { b.pos.push(p.x, y, p.y); b.nor.push(0, 1, 0) }
    for (const [p0, p1, p2] of tris) {
      const a = all[p0], c = all[p1], d = all[p2]
      const up = (c.y - a.y) * (d.x - a.x) - (c.x - a.x) * (d.y - a.y) > 0
      b.idx.push(base + p0, up ? base + p1 : base + p2, up ? base + p2 : base + p1)
    }
  }
  return geometryOf(b)
}

export interface RegionScene {
  meshes: Mesh[]
  /** Counts, for the HUD and the probes. */
  stats: { buildings: number; roads: number; water: number; tiles: number; vertices: number }
}

/** Everything the page draws for a region. */
export function regionMeshes(pack: RegionPack, l: RegionLayout, fbm: FbmSet, night: UniformNode<'float', number>, matrixMode: UniformNode<'vec4', Vector4> | null = null): RegionScene {
  const meshes: Mesh[] = []
  let vertices = 0
  // Every surface takes matrix mode (01_Initialize_World/matrixMode.ts), as the city's do: once per material, where the
  // material is made, never per mesh. The buildings' one facade is every tile's, and each wrap reads the colour under
  // it twice, so a wrap per tile doubled the shadow pass's shader with every tile until no browser could build it.
  const moded = (m: MeshStandardNodeMaterial): MeshStandardNodeMaterial => (matrixMode ? applyMatrixMode(m, matrixMode) : m)
  const add = (g: BufferGeometry, m: MeshStandardNodeMaterial, name: string, shadow: boolean, order = 0) => {
    const mesh = new Mesh(g, m)
    mesh.name = name
    mesh.receiveShadow = true
    mesh.castShadow = shadow
    mesh.renderOrder = order
    meshes.push(mesh)
    vertices += g.getAttribute('position').count
  }
  // The ground: the region and a margin, under everything.
  const b = l.bounds, margin = 3000
  const w = b.x1 - b.x0 + 2 * margin, d = b.z1 - b.z0 + 2 * margin
  add(new PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2), moded(groundMaterial(fbm)), 'RegionGround', false, 1)
  const wm = moded(waterMaterial(fbm))
  wm.polygonOffset = true
  wm.polygonOffsetFactor = -1
  wm.polygonOffsetUnits = -1
  add(waterGeometry(pack, l, 0.02), wm, 'RegionWater', false, 2)
  // Roads: sidewalks under the carriageways.
  const walks = buffers('dist'), roads = buffers('across', 'dist', 'lanes', 'twoWay', 'halfWidth')
  for (let i = 0; i < pack.roads.cls.length; i++) {
    const cls = pack.roads.cls[i]
    if (cls === ROAD_CLASS.ferry) continue
    const pts = shift(l, roadAt(pack, i))
    const { carriage, sidewalk } = roadWidth(cls, pack.roads.lanes[i])
    const half = carriage / 2
    if (sidewalk) ribbon(walks, pts, half + SIDEWALK, 0.035, (_s, dist) => ({ dist }))
    const lanes = pack.roads.lanes[i], twoWay = pack.roads.flow[i] === FLOW.both ? 1 : 0
    ribbon(roads, pts, half, 0.045, (across, dist) => ({ across, dist, lanes, twoWay, halfWidth: half }))
  }
  // The paved floors (the workplaces' rooms and forecourts): each a ribbon along x, at the sidewalks' height.
  for (const f of l.floors ?? []) {
    const z = (f.z0 + f.z1) / 2
    ribbon(walks, [[f.x0, z], [f.x1, z]], (f.z1 - f.z0) / 2, 0.035, (_s, dist) => ({ dist }))
  }
  add(geometryOf(walks), moded(sidewalkMaterial(fbm)), 'RegionSidewalks', false, 3)
  add(geometryOf(roads), moded(asphaltMaterial(fbm)), 'RegionRoads', false, 4)
  // Buildings, by tile, every tile in the one facade.
  const facade = moded(buildingMaterial(fbm, night, attribute('along', 'float') as unknown as F))
  const tiles = buildingGeometries(pack, l, 400)
  for (const [k, g] of tiles) add(g, facade, `RegionBuildings ${k}`, true)
  return {
    meshes,
    stats: { buildings: polygonCount(pack.buildings), roads: pack.roads.cls.length, water: polygonCount(pack.water), tiles: tiles.size, vertices },
  }
}


// ---------------------------------------------------------------- the workplaces

/** A region with its workplaces' lots hollowed (hollowLots): what the page draws and the physics worker walls. */
export interface HollowRegion {
  /** The pack, with every building on a chosen lot at height 0 (drawn nowhere and walled nowhere), indices kept. */
  pack: RegionPack
  /**
   * Boxes the city's renderer draws over the region and the physics worker takes as colliders: each room's shell and
   * furniture, and what stood above its ceiling slab.
   */
  plan: Building[]
  /** The rooms' floors and forecourts, for RegionLayout.floors. */
  floors: Rect[]
  rooms: Workplace[]
}

/**
 * Whether a ring is one rectangle along the axes (as fromMacro.ts writes every generated footprint): four corners,
 * every edge along an axis, and the area of its box.
 */
const isRect = (r: readonly Pt[]): boolean => {
  if (r.length !== 4 || !r.every((p, k) => (p[0] === r[(k + 1) % 4][0]) !== (p[1] === r[(k + 1) % 4][1]))) return false
  const xs = r.map((p) => p[0]), zs = r.map((p) => p[1])
  const box = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs))
  return box > 0 && Math.abs(Math.abs(area2(r)) / 2 - box) <= 1e-6 * box
}

/**
 * The region with rooms on `lots` (region/workplaces.ts regionWorkplaceLots), as a copy: the pack is only read, since
 * the page builds its world again whenever it remounts.
 * - Every building standing on a chosen lot (its box's centre in the lot's square: workplaces.ts buildingLot) gets
 *   height 0 in the copy, so the meshes and the walls skip it. Every index is kept, so every other building's finish
 *   (its index's dice) is as before.
 * - The room's ceiling slab stands for the lot's podium (workplaces.ts slabPodium): its height (the room's and a slab
 *   at least) and its finish. A lot with no podium gets the slab's least height, in the downtown mix.
 * - What stood a floor or more above the slab is carried on it, from the slab up, as the box it was and in its own
 *   finish: a hub's tower over its podium. Only a footprint that is one rectangle along the axes is a box; any other
 *   is dropped with the rest.
 * - Each room's floor (its whole lot, the doorway's threshold too) and its forecourt (the doorway's width and half a
 *   metre either side, out to the sidewalk's edge of the street it faces) are paved, at the sidewalks' height: the
 *   ground under them is lawn.
 */
export function hollowLots(pack: RegionPack, l: RegionLayout, lots: readonly WorkplaceLot[]): HollowRegion {
  const chosen = new Set(lots.map(({ k, m }) => `${k},${m}`))
  const height = pack.buildings.height.slice()
  const on = new Map<string, LotBuilding[]>()
  for (let i = 0; i < height.length; i++) {
    const at = buildingLot(pack, l.offset, i)
    if (!at || !chosen.has(`${at.K},${at.M}`)) continue
    height[i] = 0
    const key = `${at.K},${at.M}`
    on.set(key, [...(on.get(key) ?? []), at.b])
  }
  const least = ROOM.height + 0.3
  const slabOf = (k: number, m: number): { top: number; finish: number } => {
    const p = slabPodium(on.get(`${k},${m}`) ?? [])
    return p ? { top: Math.max(p.height, least), finish: buildingStyle(pack, l, p.i) } : { top: least, finish: STYLE.mixed }
  }
  const rooms = workplacesAt(lots, (k, m) => slabOf(k, m).top)
  const plan: Building[] = [], floors: Rect[] = []
  const rect = (a: { x: number; z: number }, b: { x: number; z: number }): Rect => ({ x0: Math.min(a.x, b.x), z0: Math.min(a.z, b.z), x1: Math.max(a.x, b.x), z1: Math.max(a.z, b.z) })
  // The sidewalk's edge, m from the lot's centre: the street's centre half a pitch out, less a two-lane carriageway's
  // half and the sidewalk (fromMacro.ts: every street a car uses has two lanes).
  const h = CITY.lotHalf, edge = CITY.pitch / 2 - roadWidth(ROAD_CLASS.local, 2).carriage / 2 - SIDEWALK
  for (const room of rooms) {
    const { top, finish } = slabOf(room.k, room.m)
    room.shell[5] = { ...room.shell[5], style: finish }
    plan.push(...room.shell, ...room.furniture)
    for (const b of on.get(`${room.k},${room.m}`) ?? []) {
      const rings = polygonAt(pack.buildings, b.i)
      if (b.height >= top + 3.3 - 1e-6 && rings.length === 1 && isRect(rings[0])) plan.push({ box: [b.x0, top, b.z0, b.x1, b.height, b.z1], style: buildingStyle(pack, l, b.i) })
    }
    floors.push(rect(toWorld(room, -h, -h), toWorld(room, h, h)), rect(toWorld(room, h, -ROOM.door - 0.5), toWorld(room, edge, ROOM.door + 0.5)))
  }
  return { pack: { ...pack, buildings: { ...pack.buildings, height } }, plan, floors, rooms }
}
