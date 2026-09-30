/**
 * Why does this file exist? It is the region pack: what the world compiler (region/compile.ts) writes and the engine
 * reads, one compact document per region. Coordinates are whole decimetres in the engine's frame (x east, z south,
 * region/projection.ts), in flat arrays with offset tables, so a pilot of 50,000 buildings parses in a blink and
 * compresses well. Every name in it is fictional (region/names.ts); the licences of the data it was built from travel
 * with it.
 * What breaks if it is removed? The compiler and the engine would have nothing to agree on.
 */
import type { Grid } from './projection.ts'
import type { Pt, Rect } from './clip.ts'

export const REGION_FORMAT = 'region/1'
/** Decimetres per metre: the pack's coordinate unit. */
export const DM = 10

/** Road classes, most important first (the sources' classes map onto these). */
export const ROAD_CLASS = Object.freeze({ freeway: 0, expressway: 1, ramp: 2, arterial: 3, collector: 4, local: 5, lane: 6, service: 7, ferry: 8 })
export type RoadClass = (typeof ROAD_CLASS)[keyof typeof ROAD_CLASS]
/** Traffic flow along a road's points: both ways, with the points, against them. */
export const FLOW = Object.freeze({ both: 0, forward: 1, backward: 2 })
export const WATER_KIND = Object.freeze({ lake: 0, river: 1, pond: 2 })
export const BUILDING_KIND = Object.freeze({ building: 0, worship: 1, school: 2, civic: 3 })

/** Polygons with holes, flattened: polyStart[i]..polyStart[i+1] are polygon i's rings (the first its outer ring), and
 *  ringStart[r]..ringStart[r+1] are ring r's points in xz (pairs). Every array ends with its total, so i+1 always exists. */
export interface Polygons { polyStart: number[]; ringStart: number[]; xz: number[] }

export interface RegionPack {
  format: typeof REGION_FORMAT
  /** The region's fictional name. */
  name: string
  grid: Grid
  /** The region's extent in the engine's frame, m. */
  bounds: Rect
  /** Licence statements for the data the region was built from, shown in the product's notices. */
  attribution: string[]
  /** Fictional street names; index 0 is the empty name. */
  names: string[]
  roads: { cls: number[]; lanes: number[]; flow: number[]; name: number[]; start: number[]; xz: number[] }
  water: Polygons & { kind: number[]; name: number[] }
  buildings: Polygons & { height: number[]; kind: number[] }
}

/** An empty polygon table. */
export const polygons = (): Polygons => ({ polyStart: [0], ringStart: [0], xz: [] })

/** Appends one polygon (outer ring first) to a table, in decimetres. */
export function pushPolygon(t: Polygons, rings: readonly (readonly Pt[])[]): void {
  for (const ring of rings) {
    for (const [x, z] of ring) t.xz.push(Math.round(x * DM), Math.round(z * DM))
    t.ringStart.push(t.xz.length / 2)
  }
  t.polyStart.push(t.ringStart.length - 1)
}

/** Polygon i's rings as metre points. */
export function polygonAt(t: Polygons, i: number): Pt[][] {
  const out: Pt[][] = []
  for (let r = t.polyStart[i]; r < t.polyStart[i + 1]; r++) {
    const ring: Pt[] = []
    for (let p = t.ringStart[r]; p < t.ringStart[r + 1]; p++) ring.push([t.xz[2 * p] / DM, t.xz[2 * p + 1] / DM])
    out.push(ring)
  }
  return out
}

/** How many polygons a table holds. */
export const polygonCount = (t: Polygons): number => t.polyStart.length - 1

/** Road i's points as metre points. */
export function roadAt(p: RegionPack, i: number): Pt[] {
  const out: Pt[] = []
  for (let k = p.roads.start[i]; k < p.roads.start[i + 1]; k++) out.push([p.roads.xz[2 * k] / DM, p.roads.xz[2 * k + 1] / DM])
  return out
}

/**
 * Checks a parsed pack's shape: the format, every table's lengths and offsets consistent, every coordinate a whole
 * number, every name index in range. Throws a TypeError naming the first problem.
 */
export function validatePack(u: unknown): RegionPack {
  const fail = (what: string): never => { throw new TypeError(`region pack: ${what}`) }
  if (typeof u !== 'object' || u === null) fail('not an object')
  const p = u as RegionPack
  if (p.format !== REGION_FORMAT) fail(`format ${String(p.format)}, expected ${REGION_FORMAT}`)
  if (typeof p.name !== 'string' || !p.name) fail('no name')
  if (!Array.isArray(p.names) || p.names[0] !== '') fail('names must start with the empty name')
  if (!Array.isArray(p.attribution) || !p.attribution.length) fail('no attribution')
  const ints = (a: unknown, what: string): number[] => {
    if (!Array.isArray(a) || !a.every((v) => Number.isInteger(v))) fail(`${what} is not a list of whole numbers`)
    return a as number[]
  }
  const offsets = (a: number[], total: number, what: string) => {
    if (a[0] !== 0 || a[a.length - 1] !== total) fail(`${what} does not run from 0 to ${total}`)
    for (let i = 1; i < a.length; i++) if (a[i] < a[i - 1]) fail(`${what} goes backwards at ${i}`)
  }
  const r = p.roads
  const n = r.cls.length
  for (const [k, a] of Object.entries({ cls: r.cls, lanes: r.lanes, flow: r.flow, name: r.name })) if (ints(a, `roads.${k}`).length !== n) fail(`roads.${k} has the wrong length`)
  ints(r.xz, 'roads.xz')
  if (r.start.length !== n + 1) fail('roads.start has the wrong length')
  offsets(ints(r.start, 'roads.start'), r.xz.length / 2, 'roads.start')
  if (r.name.some((i) => i < 0 || i >= p.names.length)) fail('a road names a missing name')
  for (const [key, t, extra] of [['water', p.water, ['kind', 'name']], ['buildings', p.buildings, ['height', 'kind']]] as const) {
    ints(t.xz, `${key}.xz`)
    offsets(ints(t.ringStart, `${key}.ringStart`), t.xz.length / 2, `${key}.ringStart`)
    offsets(ints(t.polyStart, `${key}.polyStart`), t.ringStart.length - 1, `${key}.polyStart`)
    for (const e of extra) if (ints((t as unknown as Record<string, unknown>)[e], `${key}.${e}`).length !== t.polyStart.length - 1) fail(`${key}.${e} has the wrong length`)
  }
  if (p.water.name.some((i) => i < 0 || i >= p.names.length)) fail('a water body names a missing name')
  return p
}
