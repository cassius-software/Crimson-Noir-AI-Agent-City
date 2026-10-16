// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one definition of the city grid: street pitch, lot size, road
 * and sidewalk bands, traffic lanes, street furniture positions, and the procedurally generated
 * buildings. Rapier colliders, traffic AI, the GPU crowd (via cityWgsl) and the street shader all
 * derive their geometry from these numbers.
 * What breaks if it is removed? Cars, people and the renderer would disagree about where things are.
 */
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import { TRAFFIC } from '../02_Define_The_Rules/civic.ts'

export const CITY = {
  /** Blocks per axis. Streets run along x = k·pitch and z = m·pitch, k,m ∈ [0, blocks]. */
  blocks: 16,
  pitch: 40,
  /** Half-size of the built lot inside each block; everything closer than this to a block centre is solid. */
  lotHalf: 13,
  /** Road half-width from the street centreline; the sidewalk runs from here to the lot edge. */
  roadHalf: 4,
  /** Pedestrian lane offset from the street centreline (outer half of the sidewalk). */
  lane: 5.8,
  /** Lamps, trees and signal poles stand this far from the centreline, at the curb. */
  furniture: 4.5,
} as const

export const CITY_SIZE = CITY.blocks * CITY.pitch
export const CITY_CENTER = CITY_SIZE / 2

/** Axis-aligned box: [minX, minY, minZ, maxX, maxY, maxZ]. */
export type Box = [number, number, number, number, number, number]

const RING = 1

/**
 * The city's districts, by lot (k, m): the block between streets k and k + 1 and m and m + 1; the ring of lots outside
 * the outer streets is k or m = −1 or `blocks`. Each has an architecture of its own, all generated here from the seed
 * (no map data, no real building copied):
 * - 'heritage': the west columns (and ring). A southern-Ontario heritage main street: two- to four-storey limestone
 *   and brick rows built to the sidewalk, with cornices and mansard caps; a church with a stepped spire; a mill with
 *   its chimney.
 * - 'lakefront': the second row from the south. Mid-rise condominiums over shops, facing the lake.
 * - 'park': the last row before the lake. Open parkland: trees and the odd pavilion.
 * - 'shore': the south ring. The promenade, the seawall, the pier, and the lake beyond (LAKE).
 * - 'downtown': everything else. Towers rising toward the centre.
 */
export type District = 'downtown' | 'heritage' | 'lakefront' | 'park' | 'shore'

/** Lot columns (from the west, the ring included) of the heritage quarter. */
export const HERITAGE_COLUMNS = 4

export function districtOfLot(k: number, m: number): District {
  if (m >= CITY.blocks) return 'shore'
  if (m === CITY.blocks - 1) return 'park'
  if (m === CITY.blocks - 2) return 'lakefront'
  if (k < HERITAGE_COLUMNS) return 'heritage'
  return 'downtown'
}

/** The district a point lies in, by name, for the HUD (generic names: no real neighbourhood is named). */
export function districtName(x: number, z: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 'Downtown'
  if (z > CITY_SIZE + CITY.roadHalf) return 'Lakefront'
  const d = districtOfLot(Math.floor(x / CITY.pitch), Math.floor(z / CITY.pitch))
  if (d === 'shore' || d === 'park' || d === 'lakefront') return 'Lakefront'
  if (d === 'heritage') return 'Heritage Quarter'
  const dx = x - CITY_CENTER, dz = z - CITY_CENTER
  if (Math.hypot(dx, dz) < CITY.pitch * 2.5) return 'Financial District'
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'Market Quarter' : 'Civic Centre'
  return dz > 0 ? 'Lakeshore' : 'Midtown'
}

/**
 * How the building material dresses a box (world.ts hands it over per instance): 'mixed' is a downtown lot's own mix
 * of curtain wall, stone, brick and panel; the rest are finishes. Only 'mixed', 'stone', 'brick' and 'condo' have
 * windows and shopfronts; trim, roofs, plain concrete and masonry, the pier's deck and its rails have none.
 */
export const STYLE = Object.freeze({ mixed: 0, stone: 1, brick: 2, trim: 3, roof: 4, concrete: 5, masonry: 6, condo: 7, deck: 8, rail: 9 })

/** A box and its finish. */
export interface Building { box: Box; style: number }

/**
 * The lake front, south of the grid. The promenade runs from the outer street's sidewalk to the seawall. The pier
 * stands on the city's north-south axis, its deck at step height (walkable), with railings. The water beyond is drawn
 * by world.ts; nothing in the physics world is water: the seawall (along the whole world, less the pier's opening) and
 * the pier's railings are the edge.
 */
export const LAKE = Object.freeze({
  /** The seawall's street-side face, z. */
  shore: CITY_SIZE + 26,
  wall: Object.freeze({ height: 1.0, thickness: 0.6, halfLength: 1600 }),
  pier: Object.freeze({ x: CITY_CENTER, halfWidth: 4, length: 80, deck: 0.3, rail: 1.1 }),
  /** Water level: just above the ground plane it hides. */
  water: 0.05,
})

type Add = (box: Box, style: number) => void

/** Downtown: a podium over the whole lot, then a headquarters tower or up to four buildings, taller toward the centre. */
function downtownLot(rng: () => number, cx: number, cz: number, add: Add): void {
  const h = CITY.lotHalf
  const core = 1 - Math.min(1, Math.hypot(cx - CITY_CENTER, cz - CITY_CENTER) / (CITY_SIZE * 0.62))
  // Podium: the whole lot is built to street level (retail base), so the lot test is exact at eye height.
  const podium = 5 + rng() * 9
  add([cx - h, 0, cz - h, cx + h, podium, cz + h], STYLE.mixed)
  if (rng() < 0.12 + core * 0.18) {
    // Corporate headquarters tower with a setback crown.
    const w = 8 + rng() * 3.5
    const d = 8 + rng() * 3.5
    const top = podium + 70 + core * 110 + rng() * 60
    add([cx - w, podium, cz - d, cx + w, top, cz + d], STYLE.mixed)
    const s = 0.6 + rng() * 0.2
    add([cx - w * s, top, cz - d * s, cx + w * s, top + 6 + rng() * 10, cz + d * s], STYLE.mixed)
    return
  }
  for (const [qx, qz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    if (rng() < 0.45) continue
    const ox = cx + qx * (h / 2) + (rng() - 0.5) * 2
    const oz = cz + qz * (h / 2) + (rng() - 0.5) * 2
    const hx = Math.min((3.5 + rng() * 2.5) * (0.8 + rng() * 0.4), h - Math.abs(ox - cx) - 0.5)
    const hz = Math.min((3.5 + rng() * 2.5) * (0.8 + rng() * 0.4), h - Math.abs(oz - cz) - 0.5)
    const height = 10 + Math.pow(rng(), 1.6) * (40 + core * 90)
    const top = podium + height
    add([ox - hx, podium, oz - hz, ox + hx, top, oz + hz], STYLE.mixed)
    if (height > 40 && rng() < 0.5) {
      const s = 0.6 + rng() * 0.25
      add([ox - hx * s, top, oz - hz * s, ox + hx * s, top + 4 + rng() * 12, oz + hz * s], STYLE.mixed)
    }
  }
}

/** Storey height of the heritage rows, m, and their parapet above the top floor. */
const STOREY = 3.6
const PARAPET = 1.0

/** One heritage row building: two to four storeys of limestone or brick, a cornice, sometimes a mansard cap. */
function row(rng: () => number, x0: number, z0: number, x1: number, z1: number, add: Add): void {
  const top = (2 + Math.floor(rng() * 3)) * STOREY + PARAPET
  add([x0, 0, z0, x1, top, z1], rng() < 0.55 ? STYLE.stone : STYLE.brick)
  add([x0 - 0.3, top, z0 - 0.3, x1 + 0.3, top + 0.5, z1 + 0.3], STYLE.trim)
  if (rng() < 0.35) add([x0 + 1.2, top + 0.5, z0 + 1.2, x1 - 1.2, top + 2.9, z1 - 1.2], STYLE.roof)
}

/** Splits [a, b] into frontages of 6–10 m (no sliver under 4 m). */
function frontages(rng: () => number, a: number, b: number): [number, number][] {
  const out: [number, number][] = []
  let x = a
  while (b - x > 0.01) {
    let w = Math.min(b - x, 6 + rng() * 4)
    if (b - x - w < 4) w = b - x
    out.push([x, x + w])
    x += w
  }
  return out
}

/**
 * A heritage block: rows built to the sidewalk on all four street fronts (north and south full width, east and west
 * between them) over a low base that fills the yard behind, so the lot is solid at eye height like every other.
 */
function heritageLot(rng: () => number, cx: number, cz: number, add: Add): void {
  const h = CITY.lotHalf
  add([cx - h, 0, cz - h, cx + h, 4.6, cz + h], STYLE.masonry)
  const deepNS = 8 + rng() * 3
  for (const side of [-1, 1] as const) {
    const [z0, z1] = side < 0 ? [cz - h, cz - h + deepNS] : [cz + h - deepNS, cz + h]
    for (const [x0, x1] of frontages(rng, cx - h, cx + h)) row(rng, x0, z0, x1, z1, add)
  }
  const deepEW = 8 + rng() * 2
  for (const side of [-1, 1] as const) {
    const [x0, x1] = side < 0 ? [cx - h, cx - h + deepEW] : [cx + h - deepEW, cx + h]
    for (const [z0, z1] of frontages(rng, cz - h + deepNS, cz + h - deepNS)) row(rng, x0, z0, x1, z1, add)
  }
}

/** The heritage quarter's church: a stone plinth, the nave under a stepped roof, a tower with its belfry and a stepped spire. */
function churchLot(cx: number, cz: number, add: Add): void {
  const h = CITY.lotHalf
  add([cx - h, 0, cz - h, cx + h, 1.2, cz + h], STYLE.stone)
  add([cx - 7, 0, cz - 6, cx + 7, 13, cz + 11], STYLE.stone)
  add([cx - 5, 13, cz - 6, cx + 5, 16, cz + 11], STYLE.roof)
  add([cx - 3.5, 0, cz - 13, cx + 3.5, 26, cz - 6], STYLE.stone)
  add([cx - 3.8, 26, cz - 13.3, cx + 3.8, 26.6, cz - 5.7], STYLE.trim)
  const steps: [number, number, number][] = [[2.6, 26.6, 31], [1.7, 31, 37], [0.9, 37, 44], [0.25, 44, 48]]
  for (const [r, y0, y1] of steps) add([cx - r, y0, cz - 9.5 - r, cx + r, y1, cz - 9.5 + r], STYLE.roof)
}

/** The heritage quarter's mill: five storeys of brick with a roof monitor, and its chimney. */
function millLot(cx: number, cz: number, add: Add): void {
  const h = CITY.lotHalf
  add([cx - h, 0, cz - h, cx + h, 4.6, cz + h], STYLE.masonry)
  add([cx - 12, 0, cz - 9, cx + 12, 18.4, cz + 9], STYLE.brick)
  add([cx - 12.3, 18.4, cz - 9.3, cx + 12.3, 18.9, cz + 9.3], STYLE.trim)
  add([cx - 10, 18.9, cz - 3, cx + 10, 21.4, cz + 3], STYLE.roof)
  add([cx + 9, 0, cz + 9.5, cx + 11.6, 40, cz + 12.1], STYLE.masonry)
  add([cx + 8.8, 40, cz + 9.3, cx + 11.8, 41.2, cz + 12.3], STYLE.trim)
}

/** A lakefront block: shops under a mid-rise slab facing the lake, a roof edge, often a penthouse set back. */
function lakefrontLot(rng: () => number, cx: number, cz: number, add: Add): void {
  const h = CITY.lotHalf
  const podium = 5 + rng() * 2
  add([cx - h, 0, cz - h, cx + h, podium, cz + h], STYLE.condo)
  const top = podium + 14 + rng() * 26
  add([cx - 11, podium, cz - 7, cx + 11, top, cz + 5], STYLE.condo)
  add([cx - 11.3, top, cz - 7.3, cx + 11.3, top + 0.6, cz + 5.3], STYLE.trim)
  if (rng() < 0.6) add([cx - 8, top + 0.6, cz - 5, cx + 8, top + 3.6, cz + 1], STYLE.condo)
}

/** A park: open ground (its trees are street furniture) and, now and then, a pavilion at its centre. */
function parkLot(rng: () => number, cx: number, cz: number, add: Add): void {
  if (rng() < 0.35) add([cx - 4, 0, cz - 3, cx + 4, 3.8, cz + 3], STYLE.concrete)
}

/** The seawall along the whole world, open for the pier; the pier's deck and its railings. */
function shoreline(add: Add): void {
  const { shore, wall, pier } = LAKE
  const x0 = CITY_CENTER - wall.halfLength, x1 = CITY_CENTER + wall.halfLength
  const g0 = pier.x - pier.halfWidth, g1 = pier.x + pier.halfWidth
  add([x0, 0, shore, g0, wall.height, shore + wall.thickness], STYLE.concrete)
  add([g1, 0, shore, x1, wall.height, shore + wall.thickness], STYLE.concrete)
  const end = shore + pier.length
  add([g0, 0, shore, g1, pier.deck, end], STYLE.deck)
  const top = pier.deck + pier.rail
  add([g0, pier.deck, shore + wall.thickness, g0 + 0.2, top, end], STYLE.rail)
  add([g1 - 0.2, pier.deck, shore + wall.thickness, g1, top, end], STYLE.rail)
  add([g0, pier.deck, end - 0.2, g1, top, end], STYLE.rail)
}

/** Every box in the city and its finish, from the seed alone. */
export function generateBuildings(seed: number): Building[] {
  const rng = createRng(seed)
  const out: Building[] = []
  const add: Add = (box, style) => { out.push({ box, style }) }
  // The heritage quarter's two landmarks stand on inner lots (never the ring), on different lots.
  const church = { k: Math.floor(rng() * (HERITAGE_COLUMNS - 1)), m: 1 + Math.floor(rng() * 5) }
  const mill = { k: Math.floor(rng() * (HERITAGE_COLUMNS - 1)), m: 7 + Math.floor(rng() * 5) }
  for (let k = -RING; k < CITY.blocks + RING; k++) {
    for (let m = -RING; m < CITY.blocks + RING; m++) {
      const cx = (k + 0.5) * CITY.pitch
      const cz = (m + 0.5) * CITY.pitch
      const d = districtOfLot(k, m)
      if (d === 'heritage' && k === church.k && m === church.m) churchLot(cx, cz, add)
      else if (d === 'heritage' && k === mill.k && m === mill.m) millLot(cx, cz, add)
      else if (d === 'heritage') heritageLot(rng, cx, cz, add)
      else if (d === 'lakefront') lakefrontLot(rng, cx, cz, add)
      else if (d === 'park') parkLot(rng, cx, cz, add)
      else if (d === 'downtown') downtownLot(rng, cx, cz, add)
    }
  }
  shoreline(add)
  return out
}

/** The city's boxes alone: what the physics worker builds colliders from. */
export function generateCity(seed: number): Box[] {
  return generateBuildings(seed).map((b) => b.box)
}

/** True if (x, z) lies inside a built lot (grown by `pad`). */
export function inLot(x: number, z: number, pad = 0): boolean {
  const lx = x - (Math.floor(x / CITY.pitch) + 0.5) * CITY.pitch
  const lz = z - (Math.floor(z / CITY.pitch) + 0.5) * CITY.pitch
  return Math.max(Math.abs(lx), Math.abs(lz)) < CITY.lotHalf + pad
}

/** The street furniture's colliders: upright cylinders standing on the ground (height, radius), m. The physics
 *  worker builds them (physics.ts); the ghost view draws the same shapes (ghost.ts). */
export const POLES = Object.freeze({
  lamp: Object.freeze({ height: 6.2, radius: 0.12 }),
  tree: Object.freeze({ height: 3.2, radius: 0.2 }),
  signal: Object.freeze({ height: 5, radius: 0.12 }),
})

export interface Furniture {
  /** [x, z, yaw] */
  lamps: [number, number, number][]
  /** [x, z, scale] */
  trees: [number, number, number][]
  /** [x, z, yaw, axis] — axis 0 controls east-west traffic, 1 north-south. The head faces oncoming cars. */
  signals: [number, number, number, number][]
}

/**
 * Lamps at 10 m and 30 m into every block, trees mid-block, both curbs of every street; one signal pole
 * per approach, on the near-right corner (right-hand traffic). The parks get six trees each, around their centre
 * (clear of a pavilion); the promenade a row of trees and lamps along the seawall, both clear of the pier.
 */
export function streetFurniture(seed: number): Furniture {
  const rng = createRng(seed + 99)
  const out: Furniture = { lamps: [], trees: [], signals: [] }
  const { pitch, blocks, furniture } = CITY
  for (let line = 0; line <= blocks; line++) {
    for (let seg = 0; seg < blocks; seg++) {
      for (const side of [-1, 1]) {
        const c = line * pitch + side * furniture
        for (const a of [10, 30]) {
          const along = seg * pitch + a
          out.lamps.push([along, c, side > 0 ? Math.PI : 0])
          out.lamps.push([c, along, side > 0 ? -Math.PI / 2 : Math.PI / 2])
        }
        const along = seg * pitch + 20
        out.trees.push([along, c, 0.85 + rng() * 0.35])
        out.trees.push([c, along, 0.85 + rng() * 0.35])
      }
    }
  }
  const s = CITY.roadHalf + 1.3
  for (let k = 0; k <= blocks; k++) {
    for (let m = 0; m <= blocks; m++) {
      const x = k * pitch, z = m * pitch
      // Approach heading +x arrives on the +z side; its signal stands at the near-right corner.
      out.signals.push([x - s, z + s, -Math.PI / 2, 0])
      out.signals.push([x + s, z - s, Math.PI / 2, 0])
      out.signals.push([x - s, z - s, Math.PI, 1])
      out.signals.push([x + s, z + s, 0, 1])
    }
  }
  for (let k = -RING; k < blocks + RING; k++) {
    const cx = (k + 0.5) * pitch, cz = (blocks - 0.5) * pitch
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + rng() * 0.6
      const r = 7.5 + rng() * 3.5
      out.trees.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r, 0.9 + rng() * 0.45])
    }
  }
  const { shore, pier } = LAKE
  for (let x = -pitch + 10; x <= CITY_SIZE + pitch - 10; x += 20) {
    if (Math.abs(x - pier.x) >= pier.halfWidth + 4) out.trees.push([x, CITY_SIZE + 15, 0.9 + rng() * 0.3])
    const lx = x + 10
    // Lamps face the promenade (their arm reaches north, over the walkway).
    if (Math.abs(lx - pier.x) >= pier.halfWidth + 2) out.lamps.push([lx, shore - 1.2, Math.PI])
  }
  return out
}

/** City constants injected ahead of every WGSL module so the GPU grid is the same grid. */
/**
 * The street geometry the crowd shader is compiled with: where the window of CITY.blocks × CITY.blocks streets lies
 * (its north-west corner, engine metres), the road half-width and the pedestrian lane of its streets, and the block edge
 * (k, m) someone is placed on when the dice find no street (never, in the city). The city's own is CITY_GEOMETRY; a
 * generated region's comes from its street window (region/streets.ts).
 */
export interface StreetGeometry {
  originX: number
  originZ: number
  roadHalf: number
  lane: number
  spawnK: number
  spawnM: number
}

export const CITY_GEOMETRY: Readonly<StreetGeometry> = Object.freeze({ originX: 0, originZ: 0, roadHalf: CITY.roadHalf, lane: CITY.lane, spawnK: 0, spawnM: 0 })

export function cityWgsl(g: Readonly<StreetGeometry> = CITY_GEOMETRY): string {
  const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`)
  return [
    `const CITY_PITCH: f32 = ${f(CITY.pitch)};`,
    `const CITY_LOT_HALF: f32 = ${f(CITY.lotHalf)};`,
    `const CITY_LANE: f32 = ${f(g.lane)};`,
    `const CITY_ROAD_HALF: f32 = ${f(g.roadHalf)};`,
    `const CITY_BLOCKS: i32 = ${CITY.blocks};`,
    `const CITY_SIZE: f32 = ${f(CITY_SIZE)};`,
    `const CITY_ORIGIN_X: f32 = ${f(g.originX)};`,
    `const CITY_ORIGIN_Z: f32 = ${f(g.originZ)};`,
    `const SPAWN_K: i32 = ${g.spawnK};`,
    `const SPAWN_M: i32 = ${g.spawnM};`,
    `const TRAFFIC_LANE: f32 = ${f(TRAFFIC.laneOffset)};`,
  ].join('\n')
}
