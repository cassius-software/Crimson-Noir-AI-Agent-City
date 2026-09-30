/**
 * Why does this file exist? It is the geometry behind the spatial harness (harness.ts `spatial`): the plan of agents
 * to inject into the city and what each must do, derived from the world seed alone, so the probes follow the
 * generator wherever it puts a building. For every district it picks sidewalk runs (the avatar must get through) and
 * runs into a building (the avatar must stop at the face the generator placed, give or take its skin); on the shore,
 * the seawall, the pier's deck, its railings and its far end; on every kind of street, a car in its lane that must
 * drive on. It judges each probe from where its agent ended. It also holds the crowd's invariants, which crowd.wgsl
 * enforces every step: nobody inside a lot (by the push-out pad), nobody past the city clamp (so never in the lake),
 * nobody non-finite; and it counts anyone on a carriageway away from a crosswalk. Pure: no physics, no engine, no
 * clock.
 * What breaks if it is removed? The spatial harness has no plan, and a building without a collider, a gap in the
 * seawall or a crowd walking through lots would go unnoticed.
 */
import {
  CITY, CITY_SIZE, LAKE, districtOfLot, generateBuildings, streetFurniture, type Box, type District,
} from '../01_Initialize_World/city.ts'
import { TRAFFIC } from '../02_Define_The_Rules/civic.ts'
import { Driver } from '../06_Make_Decisions/traffic.ts'
import { PERSON, RUN } from './simProtocol.ts'

/** The character controller's skin (player.ts): the capsule stops this far short of a face, m. */
export const SKIN = 0.02
/** Where a run into a face may stop, either side of the expected spot, m. */
export const STOP_TOLERANCE = 0.15
/** The deck is a step up (player.ts autostep); anything lower is walked onto, anything taller stops a person, m. */
const STEP = 0.35
/** The capsule's height: a box that starts above it is a cornice overhead, not a wall, m. */
const BODY_TOP = PERSON.halfHeight * 2 + PERSON.radius * 2
/** The crowd's containment (crowd.wgsl): pushOut's pad beyond the lot, and clampCity's margin past the outer streets, m. */
export const CROWD_LOT_PAD = 0.35
export const CROWD_CLAMP = 6.5
/** Slack for f32 positions read back from the GPU, m. */
const CROWD_EPS = 0.05

export type Vec2 = readonly [number, number]

/** One injected walk: teleported to `from`, run along `dir` for `seconds` (at RUN), then judged. */
export interface WalkProbe {
  readonly district: District | 'promenade' | 'pier'
  /** What it proves, in a few words (the report names it). */
  readonly what: string
  readonly from: Vec2
  readonly dir: Vec2
  readonly seconds: number
  /** Free run: metres it must at least advance along `dir`. */
  readonly min: number
  /** A run into a face: where it must stop, metres along `dir` from `from` (null: free). */
  readonly stop: number | null
  /** The feet's height at the end, m (the pier's deck), or null for the ground. */
  readonly feet: number | null
}

/** One injected car: set down in its lane, driven on for `seconds` at full throttle, then judged. */
export interface CarProbe {
  readonly district: District
  readonly what: string
  readonly x: number
  readonly z: number
  readonly heading: number
  readonly seconds: number
  /** Metres it must at least advance along its heading. */
  readonly min: number
}

export interface SpatialPlan {
  readonly seed: number
  readonly walks: readonly WalkProbe[]
  readonly cars: readonly CarProbe[]
}

const pitch = CITY.pitch
const lotCentre = (k: number): number => (k + 0.5) * pitch

/** A small integer hash of the seed and a lot, for choosing lots without a stateful generator. */
function mix(seed: number, k: number, m: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 1000, 0xc2b2ae35) ^ Math.imul(m + 7000, 0x27d4eb2f)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return h >>> 0
}

/** A box a standing person cannot step onto or walk under: it reaches above a step and starts below the body's top. */
const blocks = (b: Box): boolean => b[4] > STEP && b[1] < BODY_TOP

/**
 * The first face a person running from (x, z0) along ±z meets, as the z its body's centre stops at, and whether that
 * face spans the whole capsule with room to spare (no corner to slide around). Null if nothing stops it before `limit`.
 */
export function faceAlongZ(boxes: readonly Box[], x: number, z0: number, sz: 1 | -1, limit: number): { stop: number; square: boolean } | null {
  const r = PERSON.radius
  let best: Box | null = null
  let bestZ = Infinity
  for (const b of boxes) {
    if (!blocks(b) || b[3] < x - r || b[0] > x + r) continue
    const face = sz > 0 ? b[2] : b[5]
    const dist = (face - z0) * sz
    if (dist < -0.01 || dist > limit || dist >= bestZ) continue
    best = b
    bestZ = dist
  }
  if (!best) return null
  const square = best[0] <= x - r - 0.3 && best[3] >= x + r + 0.3
  return { stop: bestZ - r - SKIN, square }
}

/** True if nothing solid (a box, a pole with its radius) is within `clear` of the segment from a to b. */
export function clearPath(boxes: readonly Box[], poles: readonly Vec2[], a: Vec2, b: Vec2, clear: number): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25))
  for (let i = 0; i <= n; i++) {
    const x = a[0] + ((b[0] - a[0]) * i) / n, z = a[1] + ((b[1] - a[1]) * i) / n
    for (const p of poles) if (Math.hypot(p[0] - x, p[1] - z) < clear + 0.2) return false
    for (const bx of boxes) {
      if (!blocks(bx)) continue
      if (x > bx[0] - clear && x < bx[3] + clear && z > bx[2] - clear && z < bx[5] + clear) return false
    }
  }
  return true
}

/** What a plan is drawn on: every solid box of the city, and every pole (lamps, trees, signals) as a point. */
export interface PlanCity {
  readonly boxes: readonly Box[]
  readonly poles: readonly Vec2[]
}

/** The city the generator builds for `seed`, as the plan sees it. */
export function planCity(seed: number): PlanCity {
  const furniture = streetFurniture(seed)
  return {
    boxes: generateBuildings(seed).map((b) => b.box),
    poles: [...furniture.lamps, ...furniture.trees, ...furniture.signals].map((p) => [p[0], p[1]] as const),
  }
}

/**
 * The plan for a world seed: per district two lots (chosen by hash, so the same seed always gives the same plan),
 * each with a free run along its sidewalk and a run into its buildings (a park's is free: parks are open); the
 * shore's four probes; and cars on six streets, the grid's new outer streets among them. Every run is clear of the
 * poles and boxes of `city` (the seed's own unless one is given): a lot whose sidewalk is not is passed over, and a
 * run into a lot moves along it to a clear, square face.
 */
export function spatialPlan(seed: number, city: PlanCity = planCity(seed)): SpatialPlan {
  const { boxes, poles } = city
  const r = PERSON.radius
  const walks: WalkProbe[] = []
  const districts: District[] = ['downtown', 'heritage', 'lakefront', 'park']
  for (const district of districts) {
    const lots: [number, number][] = []
    for (let k = -1; k <= CITY.blocks; k++) {
      for (let m = -1; m < CITY.blocks; m++) if (districtOfLot(k, m) === district) lots.push([k, m])
    }
    lots.sort((a, b) => mix(seed, a[0], a[1]) - mix(seed, b[0], b[1]))
    let taken = 0
    for (const [k, m] of lots) {
      if (taken === 2) break
      // The lot's side that faces a street of the grid, and the sidewalk lane along it.
      const north = m >= 0
      const street = north ? m * pitch : (m + 1) * pitch
      const into: 1 | -1 = north ? 1 : -1
      const laneZ = street + into * CITY.lane
      const cx = lotCentre(k)
      // The sidewalk run: from 6 m west of the lot's middle, east for about 10 m (mid-block, clear of the corners).
      const run = RUN * 2
      const a: Vec2 = [cx - 6, laneZ], b: Vec2 = [cx - 6 + run, laneZ]
      if (!clearPath(boxes, poles, a, b, r + 0.1)) continue
      // The run into the lot: the first offset whose face is square to the run (or, in a park, a clear 6 m in).
      let wall: WalkProbe | null = null
      for (const dx of [0, -6, 6, -9, 9, -3, 3]) {
        const x = cx + dx
        const face = faceAlongZ(boxes, x, laneZ, into, pitch / 2)
        if (district === 'park') {
          const end: Vec2 = [x, laneZ + into * 6]
          if (!face && clearPath(boxes, poles, [x, laneZ], end, r + 0.1)) {
            wall = { district, what: `into the park at (${Math.round(x)}, ${Math.round(laneZ)}): open`, from: [x, laneZ], dir: [0, into], seconds: 1.5, min: 5, stop: null, feet: null }
            break
          }
          continue
        }
        if (!face || !face.square) continue
        if (!clearPath([], poles, [x, laneZ], [x, laneZ + into * face.stop], r + 0.1)) continue
        wall = { district, what: `into the building at (${Math.round(x)}, ${Math.round(laneZ)})`, from: [x, laneZ], dir: [0, into], seconds: Math.max(1, face.stop / RUN + 0.8), min: 0, stop: face.stop, feet: null }
        break
      }
      if (!wall) continue
      walks.push({ district, what: `along the sidewalk of lot (${k}, ${m})`, from: a, dir: [1, 0], seconds: 2, min: run - 1.2, stop: null, feet: null })
      walks.push(wall)
      taken++
    }
  }
  // The shore: the seawall stops a run into the lake (twice, clear of the promenade's lamps and trees); the pier is a
  // step up and walkable out over the water; its railings and far end stop a run off it.
  const { shore, pier } = LAKE
  const g1 = pier.x + pier.halfWidth, end = shore + pier.length
  for (const x of [pier.x - 235, pier.x + 185]) {
    walks.push({ district: 'promenade', what: `into the seawall at x ${x}`, from: [x, shore - 5], dir: [0, 1], seconds: 2, min: 0, stop: 5 - r - SKIN, feet: null })
  }
  walks.push({ district: 'pier', what: 'onto the pier and out over the lake', from: [pier.x, shore - 5], dir: [0, 1], seconds: 6, min: 25, stop: null, feet: pier.deck })
  walks.push({ district: 'pier', what: "into the pier's east railing", from: [pier.x, shore + 30], dir: [1, 0], seconds: 1.5, min: 0, stop: g1 - 0.2 - pier.x - r - SKIN, feet: pier.deck })
  walks.push({ district: 'pier', what: "into the rail at the pier's end", from: [pier.x, end - 8], dir: [0, 1], seconds: 2.5, min: 0, stop: 8 - 0.2 - r - SKIN, feet: pier.deck })
  // Cars: in their lane mid-block, a car length past the corner, driving away from it.
  const car = (district: District, what: string, k: number, m: number, dir: Vec2): CarProbe => {
    const p = Driver.lanePose([k, m], [dir[0], dir[1]], 14)
    return { district, what, x: p.x, z: p.z, heading: p.heading, seconds: 2.5, min: 8 }
  }
  const B = CITY.blocks
  const cars: CarProbe[] = [
    car('downtown', 'south on a downtown avenue', B / 2, B / 2 - 2, [0, 1]),
    car('heritage', 'east through the heritage quarter', 0, 3, [1, 0]),
    car('lakefront', 'west along the lakefront street', B - 4, B - 1, [-1, 0]),
    car('shore', 'east along the lakeshore street (the grid edge)', 6, B, [1, 0]),
    car('downtown', 'north on the east edge street', B, B / 2 + 1, [0, -1]),
    car('downtown', 'south on the old grid edge', 12, 4, [0, 1]),
  ]
  return Object.freeze({ seed, walks: Object.freeze(walks), cars: Object.freeze(cars) })
}

// ---------------------------------------------------------------------------------------------------
// Verdicts: what each injected agent must have done, judged from where it ended. Nothing not finite passes.

const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '-')
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '-')

/** How far the avatar may land from a probe's start, m (farther: something stood on the spot). */
const LANDING = 0.3
/** How far the feet may be from the pier's deck, and from the ground, at the end of a run, m. */
const FEET_ON_DECK = 0.08
const FEET_ON_GROUND = 0.12
/** How far an injected car may end off its line, m, and how far it may have turned, rad. */
export const CAR_DRIFT = 0.8
export const CAR_TURN = 0.1
/** Car probes that may be skipped for traffic in their lane. */
export const STREETS_SKIPPABLE = 2
/** Share of pedestrians that may be on a carriageway away from a crosswalk (stepping back from a car, say). */
export const OFF_CROSSWALK_SHARE = 0.02
/** Share of the crowd that must have a position (the rest are still being placed). */
const CROWD_PLACED = 0.9

/** Where the avatar stands (SimControls.avatar.position), feet height included. */
export interface Stance {
  readonly x: number
  readonly z: number
  readonly feetY: number
}

/** Metres a point lies along a walk probe's direction from its start. */
export function alongWalk(p: WalkProbe, a: { readonly x: number; readonly z: number }): number {
  return (a.x - p.from[0]) * p.dir[0] + (a.z - p.from[1]) * p.dir[1]
}

/** Why the avatar did not land on a probe's start (something stood on the spot), or null if it did. */
export function judgeLanding(p: WalkProbe, a: { readonly x: number; readonly z: number }): string | null {
  if (Math.hypot(a.x - p.from[0], a.z - p.from[1]) <= LANDING) return null
  return `${p.what}: landed at (${f1(a.x)}, ${f1(a.z)}), not at (${f1(p.from[0])}, ${f1(p.from[1])}): something stands on the spot`
}

/**
 * Why a walk probe failed, judged where the avatar ended, or null: a free run must have got at least `min` along; a
 * run into a face must have stopped within STOP_TOLERANCE of it (past it, it went into the geometry); the feet must
 * be on the deck, or on the ground.
 */
export function judgeWalk(p: WalkProbe, a: Stance): string | null {
  const d = alongWalk(p, a)
  if (p.stop === null && !(d >= p.min)) return `${p.what}: got ${f1(d)} m of the ${f1(p.min)} m it must get through (stopped at ${f1(a.x)}, ${f1(a.z)})`
  if (p.stop !== null && !(Math.abs(d - p.stop) <= STOP_TOLERANCE)) {
    return `${p.what}: stopped ${f2(d)} m in, expected ${f2(p.stop)} m (± ${STOP_TOLERANCE})${d > p.stop ? ': it went into the geometry' : ''}`
  }
  if (p.feet !== null && !(Math.abs(a.feetY - p.feet) <= FEET_ON_DECK)) return `${p.what}: feet at ${f2(a.feetY)} m, expected the deck at ${f2(p.feet)} m`
  if (p.feet === null && !(Math.abs(a.feetY) <= FEET_ON_GROUND)) return `${p.what}: feet at ${f2(a.feetY)} m, expected the ground`
  return null
}

/**
 * A car probe judged where the car ended (SimControls.vehicles.state): how far on along its heading, how far off its
 * line, how far it turned; and why it failed (it must have come at least `min` on, within CAR_DRIFT of its line,
 * turned no more than CAR_TURN), or null.
 */
export function judgeCar(probe: CarProbe, s: { readonly x: number; readonly z: number; readonly heading: number }): { along: number; lateral: number; turned: number; failure: string | null } {
  const fx = Math.sin(probe.heading), fz = Math.cos(probe.heading)
  const dx = s.x - probe.x, dz = s.z - probe.z
  const along = dx * fx + dz * fz, lateral = Math.abs(dx * fz - dz * fx)
  const turned = Math.abs(Math.atan2(Math.sin(s.heading - probe.heading), Math.cos(s.heading - probe.heading)))
  const ok = along >= probe.min && lateral <= CAR_DRIFT && turned <= CAR_TURN
  return { along, lateral, turned, failure: ok ? null : `${probe.what}: ${f1(along)} m on (at least ${probe.min}), ${f2(lateral)} m off its line, turned ${f2(turned)} rad` }
}

/** The car probes' verdict: each one's failure, and too many skipped (at most STREETS_SKIPPABLE); empty if they held. */
export function streetFailures(ran: number, of: number, failures: readonly string[]): string[] {
  const out = [...failures]
  if (ran < of - STREETS_SKIPPABLE) out.push(`only ${ran} of ${of} streets driven: traffic kept more than ${STREETS_SKIPPABLE} lanes busy`)
  return out
}

/** Signed offsets of (x, z) from the nearest north-south and east-west street centrelines. */
function offsets(x: number, z: number): [number, number] {
  return [x - Math.round(x / pitch) * pitch, z - Math.round(z / pitch) * pitch]
}

/** On a carriageway (crowd.wgsl onRoad) and not on a zebra crosswalk: mid-block, or out in an intersection's box. */
export function offCrosswalk(x: number, z: number): boolean {
  const [ox, oz] = offsets(x, z)
  const ax = Math.abs(ox), az = Math.abs(oz)
  if (Math.min(ax, az) >= CITY.roadHalf) return false
  // Across an east-west road (|oz| small) the zebra is the band |ox| in [a, b], in line with the sidewalks of the
  // north-south street; likewise with the axes swapped.
  const [a, b] = TRAFFIC.crosswalk
  const band = (along: number) => along >= a - 0.3 && along <= b + 0.3
  if (az < CITY.roadHalf && band(ax)) return false
  if (ax < CITY.roadHalf && band(az)) return false
  return true
}

/** What the crowd check found in one or more readings of every pedestrian's position. */
export interface CrowdFinding {
  /** Pedestrians read (agent 0, the player's own body, excluded), per reading summed. */
  readonly measured: number
  /** Not yet placed by the crowd (NaN in the reading). */
  readonly unplaced: number
  /** Inside a lot (closer to its middle than the push-out pad allows). */
  readonly inLot: number
  /** Beyond the city clamp (and so possibly in the lake). */
  readonly outside: number
  readonly nonFinite: number
  /** On a carriageway away from any crosswalk (reported, not a failure below 2 %). */
  readonly offCrosswalk: number
  /** Up to five offenders, as "agent i at (x, z): why". */
  readonly examples: readonly string[]
}

/** Checks one reading of the crowd (x, z per agent, as SimControls.crowd.positions returns it) against its invariants. */
export function checkCrowd(xz: ArrayLike<number>, into?: { counts: Record<keyof Omit<CrowdFinding, 'examples'>, number>; examples: string[] }): CrowdFinding {
  const acc = into ?? { counts: { measured: 0, unplaced: 0, inLot: 0, outside: 0, nonFinite: 0, offCrosswalk: 0 }, examples: [] }
  const c = acc.counts
  const n = Math.floor(xz.length / 2)
  const note = (i: number, x: number, z: number, why: string) => {
    if (acc.examples.length < 5) acc.examples.push(`agent ${i} at (${x.toFixed(1)}, ${z.toFixed(1)}): ${why}`)
  }
  for (let i = 1; i < n; i++) {
    const x = xz[2 * i], z = xz[2 * i + 1]
    if (Number.isNaN(x) && Number.isNaN(z)) { c.unplaced++; continue }
    c.measured++
    if (!Number.isFinite(x) || !Number.isFinite(z)) { c.nonFinite++; note(i, x, z, 'not a finite position'); continue }
    const lo = -CROWD_CLAMP - CROWD_EPS, hi = CITY_SIZE + CROWD_CLAMP + CROWD_EPS
    if (x < lo || x > hi || z < lo || z > hi) {
      c.outside++
      note(i, x, z, z > LAKE.shore ? 'in the lake' : 'outside the city')
      continue
    }
    const lx = x - (Math.floor(x / pitch) + 0.5) * pitch, lz = z - (Math.floor(z / pitch) + 0.5) * pitch
    if (Math.max(Math.abs(lx), Math.abs(lz)) < CITY.lotHalf + CROWD_LOT_PAD - CROWD_EPS) {
      c.inLot++
      note(i, x, z, 'inside a lot')
      continue
    }
    if (offCrosswalk(x, z)) c.offCrosswalk++
  }
  return { ...c, examples: acc.examples }
}

/**
 * The crowd's verdict over its readings (checkCrowd's counts, summed across them): what failed, in words; empty if it
 * held. At least two readings; CROWD_PLACED of the crowd with a position; nobody outside the containment; at most
 * OFF_CROSSWALK_SHARE on a carriageway off the zebras.
 */
export function crowdFailures(c: CrowdFinding, readings: number): string[] {
  const out: string[] = []
  if (readings < 2) out.push('the crowd gave fewer than two readings')
  const placed = c.measured / Math.max(1, c.measured + c.unplaced)
  if (!(placed >= CROWD_PLACED)) out.push(`only ${(placed * 100).toFixed(0)} % of the crowd had a position`)
  const bad = c.inLot + c.outside + c.nonFinite
  if (bad > 0) out.push(`${bad} found outside the crowd's containment`)
  const off = c.measured > 0 ? c.offCrosswalk / c.measured : 0
  if (off > OFF_CROSSWALK_SHARE) out.push(`${(off * 100).toFixed(2)} % on a carriageway off the zebras (at most ${OFF_CROSSWALK_SHARE * 100} %)`)
  return out
}
