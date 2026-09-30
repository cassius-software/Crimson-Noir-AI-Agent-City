/**
 * Why does this file exist? The world compiler's pure core: surveyed sources in, a region pack out. It projects every
 * feature into the engine's frame (region/projection.ts), clips it to the region (region/clip.ts), drops the vertices
 * it does not need, maps the sources' classes onto the engine's, groups holes with the polygons they pierce, and gives
 * every street and water body a fictional name (region/names.ts). Nothing here reads a file or the network: the
 * command line (tools/world/compile.mjs) hands the sources in, with the real names to deny.
 * What breaks if it is removed? The fetched data cannot become a place the engine can build.
 */
import { clipLine, clipRing, signedArea2, simplifyLine, simplifyRing, type Pt, type Rect } from './clip.ts'
import { NameBook, normal, streetName } from './names.ts'
import {
  BUILDING_KIND, DM, FLOW, REGION_FORMAT, ROAD_CLASS, WATER_KIND, polygons, pushPolygon, type RegionPack,
} from './pack.ts'
import { toGrid, type Grid } from './projection.ts'

/** A road segment as the road network composite publishes it (the fields the compiler reads). */
export interface RoadFeature {
  attributes: {
    ROAD_CLASS?: string | null; ROAD_ELEMENT_TYPE?: string | null; DIRECTION_OF_TRAFFIC_FLOW?: string | null
    NUMBER_OF_LANES?: string | number | null; FULL_STREET_NAME?: string | null; STREET_NAME_BODY?: string | null
    STREET_TYPE_SUFFIX?: string | null
  }
  geometry?: { paths: number[][][] } | null
}
/** A water body as the hydro network publishes it. */
export interface WaterFeature {
  attributes: { WATERBODY_TYPE?: string | null; OFFICIAL_NAME_LABEL?: string | null }
  geometry?: { rings: number[][][] } | null
}
/** A building as the building database gives it: longitude/latitude rings, height (m) and storeys. */
export interface BuildingRecord {
  rings: number[][][]
  height?: string | number | null
  floors?: string | number | null
  type?: string | null
}

export interface CompileInput {
  /** The region's fictional name (checked against the denylist too). */
  name: string
  grid: Grid
  /** West, south, east, north (degrees): the region is the largest grid rectangle inside it. */
  bbox: readonly [number, number, number, number]
  roads: readonly RoadFeature[]
  water: readonly WaterFeature[]
  buildings: readonly BuildingRecord[]
  /** Real names no fictional name may be: the region's places, landmarks, anything the sources do not list. */
  deny: Iterable<string>
  attribution: string[]
  /** Salt for the name book: another salt, another set of names. */
  salt?: string
}

const CLASSES: Record<string, number> = {
  'FREEWAY': ROAD_CLASS.freeway, 'EXPRESSWAY / HIGHWAY': ROAD_CLASS.expressway, 'RAMP': ROAD_CLASS.ramp,
  'ARTERIAL': ROAD_CLASS.arterial, 'COLLECTOR': ROAD_CLASS.collector, 'LOCAL / STREET': ROAD_CLASS.local,
  'LOCAL / STRATA': ROAD_CLASS.local, 'LOCAL / UNKNOWN': ROAD_CLASS.local, 'ALLEYWAY / LANEWAY': ROAD_CLASS.lane,
  'SERVICE': ROAD_CLASS.service,
}
/** Lanes a road of each class has when the sources do not say. */
const DEFAULT_LANES = [4, 4, 1, 4, 2, 2, 1, 1, 1]
const DIRECTIONS = new Set(['EAST', 'WEST', 'NORTH', 'SOUTH'])

/** The largest grid-aligned rectangle inside a longitude/latitude box (its edges curve a little in the grid). */
export function regionRect(g: Grid, bbox: readonly [number, number, number, number]): Rect {
  const [w, s, e, n] = bbox
  const sw = toGrid(g, w, s), nw = toGrid(g, w, n), se = toGrid(g, e, s), ne = toGrid(g, e, n)
  // z runs south: the north edge has the smaller z.
  return { x0: Math.max(sw.x, nw.x), x1: Math.min(se.x, ne.x), z0: Math.max(nw.z, ne.z), z1: Math.min(sw.z, se.z) }
}

const project = (g: Grid, ring: readonly number[][]): Pt[] => ring.map(([lon, lat]) => {
  const p = toGrid(g, lon, lat)
  return [p.x, p.z] as Pt
})

/** Point in ring (even-odd). */
function inside(p: Pt, ring: readonly Pt[]): boolean {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j]
    if ((zi > p[1]) !== (zj > p[1]) && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) c = !c
  }
  return c
}

/**
 * Rings (any orientation, holes mixed in) as polygons: each ring whose signed area is the larger sign is an outer
 * ring; every other ring joins the smallest outer ring it lies in. Outer rings end up counter-clockwise in (x, north)
 * (clockwise in the engine's x, z), holes the other way, as a triangulator expects.
 */
export function groupRings(rings: readonly Pt[][]): Pt[][][] {
  const rs = rings.filter((r) => r.length >= 3)
  if (!rs.length) return []
  // In the engine's frame (z south) a ring counter-clockwise on the map has a negative signedArea2.
  const area = rs.map((r) => -signedArea2(r))
  const outerSign = Math.sign(area[area.map(Math.abs).indexOf(Math.max(...area.map(Math.abs)))]) || 1
  const outers = rs.map((r, i) => ({ r, a: Math.abs(area[i]), outer: Math.sign(area[i]) === outerSign })).filter((o) => o.outer)
  const polys = outers.map((o) => ({ outer: o, holes: [] as Pt[][] }))
  rs.forEach((r, i) => {
    if (Math.sign(area[i]) === outerSign) return
    const host = polys.filter((p) => inside(r[0], p.outer.r)).sort((a, b) => a.outer.a - b.outer.a)[0]
    if (host) host.holes.push(r)
  })
  const orient = (r: Pt[], ccwMap: boolean): Pt[] => ((-signedArea2(r) > 0) === ccwMap ? r : r.slice().reverse())
  return polys.map((p) => [orient(p.outer.r, true), ...p.holes.map((h) => orient(h, false))])
}

export function compileRegion(input: CompileInput): RegionPack {
  const g = input.grid
  const rect = regionRect(g, input.bbox)
  const book = new NameBook(input.deny, input.salt ?? 'region')
  // Every real name the sources carry is denied before any fictional name is made.
  for (const f of input.roads) {
    for (const s of [f.attributes.STREET_NAME_BODY, f.attributes.FULL_STREET_NAME]) if (s) book.forbid(s)
  }
  for (const f of input.water) if (f.attributes.OFFICIAL_NAME_LABEL) book.forbid(f.attributes.OFFICIAL_NAME_LABEL)
  if (!book.allowed(input.name)) throw new Error(`the region's name "${input.name}" is a real name`)

  const names: string[] = ['']
  const nameIndex = new Map<string, number>([['', 0]])
  const intern = (s: string): number => {
    let i = nameIndex.get(s)
    if (i === undefined) {
      i = names.length
      names.push(s)
      nameIndex.set(s, i)
    }
    return i
  }

  // Roads.
  const roads: RegionPack['roads'] = { cls: [], lanes: [], flow: [], name: [], start: [0], xz: [] }
  for (const f of input.roads) {
    const a = f.attributes
    const type = (a.ROAD_ELEMENT_TYPE ?? '').toUpperCase()
    if (type === 'VIRTUAL ROAD' || !f.geometry) continue
    const cls = type === 'FERRY CONNECTION' ? ROAD_CLASS.ferry : CLASSES[(a.ROAD_CLASS ?? '').toUpperCase()] ?? ROAD_CLASS.local
    const lanesRaw = Number(a.NUMBER_OF_LANES)
    const lanes = Number.isFinite(lanesRaw) && lanesRaw > 0 ? Math.min(12, Math.round(lanesRaw)) : DEFAULT_LANES[cls]
    const flowRaw = (a.DIRECTION_OF_TRAFFIC_FLOW ?? '').toUpperCase()
    const flow = flowRaw === 'POSITIVE' ? FLOW.forward : flowRaw === 'NEGATIVE' ? FLOW.backward : FLOW.both
    const full = normal(a.FULL_STREET_NAME ?? '').split(' ')
    const direction = full.length > 1 && DIRECTIONS.has(full[full.length - 1]) ? full[full.length - 1] : null
    const name = intern(streetName(book, a.STREET_NAME_BODY, a.STREET_TYPE_SUFFIX, direction))
    for (const path of f.geometry.paths) {
      for (const run of clipLine(project(g, path), rect)) {
        const pts = simplifyLine(run, 0.1)
        if (pts.length < 2) continue
        roads.cls.push(cls); roads.lanes.push(lanes); roads.flow.push(flow); roads.name.push(name)
        for (const [x, z] of pts) roads.xz.push(Math.round(x * DM), Math.round(z * DM))
        roads.start.push(roads.xz.length / 2)
      }
    }
  }

  // Water: each feature's rings clipped, grouped into polygons with their holes (the lake's islands).
  const water = { ...polygons(), kind: [] as number[], name: [] as number[] }
  for (const f of input.water) {
    if (!f.geometry) continue
    const t = (f.attributes.WATERBODY_TYPE ?? '').toUpperCase()
    const kind = t === 'LAKE' ? WATER_KIND.lake : t === 'RIVER' || t === 'CANAL' ? WATER_KIND.river : WATER_KIND.pond
    const label = f.attributes.OFFICIAL_NAME_LABEL
    const name = label ? intern(`${book.name(label)}${kind === WATER_KIND.lake ? ' Lake' : kind === WATER_KIND.river ? ' River' : ' Pond'}`) : 0
    const rings = f.geometry.rings.map((r) => simplifyRing(clipRing(project(g, r), rect), 0.3)).filter((r) => r.length >= 3)
    for (const poly of groupRings(rings)) {
      pushPolygon(water, poly)
      water.kind.push(kind)
      water.name.push(name)
    }
  }

  // Buildings: kept whole when their first vertex lies in the region (no half buildings on the edge).
  const buildings = { ...polygons(), height: [] as number[], kind: [] as number[] }
  for (const b of input.buildings) {
    if (!b.rings?.length) continue
    const rings = b.rings.map((r) => simplifyRing(project(g, r), 0.05)).filter((r) => r.length >= 3)
    if (!rings.length) continue
    const [x, z] = rings[0][0]
    if (x < rect.x0 || x > rect.x1 || z < rect.z0 || z > rect.z1) continue
    const h = Number(b.height), floors = Number(b.floors)
    const height = Number.isFinite(h) && h > 0 ? h : Number.isFinite(floors) && floors > 0 ? floors * 3.5 : 7
    const type = (b.type ?? '').toUpperCase()
    const kind = /WORSHIP/.test(type) ? BUILDING_KIND.worship : /SCHOOL/.test(type) ? BUILDING_KIND.school : /COMMUNITY|CIVIC/.test(type) ? BUILDING_KIND.civic : BUILDING_KIND.building
    for (const poly of groupRings(rings)) {
      pushPolygon(buildings, poly)
      buildings.height.push(Math.max(1, Math.round(Math.min(height, 700) * DM)))
      buildings.kind.push(kind)
    }
  }

  return {
    format: REGION_FORMAT, name: input.name, grid: g, bounds: rect, attribution: input.attribution, names, roads, water, buildings,
  }
}

/**
 * Every real name found in a pack's names (the region's name included), in any case: a name equal to a denied one, a
 * denied name of two or more words found whole inside one, or any word of a denied name (four letters or more) that is
 * not an ordinary street-type or direction word (`ordinary`: "Avenue", "West"; a real street may be named by such a
 * word alone, as "Avenue Road" is, without every avenue naming it). Empty for a pack that is fit to ship.
 */
export function realNamesIn(pack: RegionPack, deny: Iterable<string>, ordinary: Iterable<string> = []): string[] {
  const plain = new Set([...ordinary].map(normal))
  const whole = new Set<string>(), phrases = new Set<string>(), words = new Set<string>()
  for (const d of deny) {
    const n = normal(d)
    if (!n) continue
    whole.add(n)
    if (n.includes(' ')) phrases.add(n)
    for (const w of n.split(' ')) if (w.length >= 4 && !plain.has(w)) words.add(w)
  }
  const found: string[] = []
  for (const s of [pack.name, ...pack.names]) {
    const n = normal(s)
    if (!n) continue
    if (whole.has(n)) found.push(`${s} = a real name`)
    const padded = ` ${n} `
    for (const p of phrases) if (padded.includes(` ${p} `)) found.push(`${s} ⊃ ${p}`)
    for (const w of n.split(' ')) if (words.has(w)) found.push(`${s} ⊃ ${w}`)
  }
  return [...new Set(found)]
}

/** The ordinary words a fictional street keeps from its real one: the sources' street types, and the directions. */
export function ordinaryWords(roads: readonly RoadFeature[]): string[] {
  const out = new Set<string>(DIRECTIONS)
  for (const f of roads) if (f.attributes.STREET_TYPE_SUFFIX) out.add(normal(f.attributes.STREET_TYPE_SUFFIX))
  for (const w of ['LAKE', 'RIVER', 'POND']) out.add(w)
  return [...out]
}
