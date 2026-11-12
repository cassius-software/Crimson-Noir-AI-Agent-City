// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? A region's streets are lit by paint wherever no real light reaches them: on a lite boot
 * (an entry-level phone builds no lights at all, world.ts LITE_WORLD), under a headset, and on every other tier past
 * the lamps that tier lights. The procedural city paints its lamp pools from a pixel's place on the grid
 * (materials.ts lampPool): every one of its streets has lamps. A region's street window has streets missing, lots
 * turned into rooms and buildings standing wherever the map put them, so its paint is a picture instead: the window
 * seen from above, a texel a metre, baked once at boot from what really stands there and read by the region's asphalt,
 * pavement and lawn with one texture sample (regionWorld.ts). Three kinds of light, a channel each:
 * - red, the street lamps' pools: the light a lamp's head (cityLights.ts lampHead) throws on the ground under it, by
 *   the law a point of light LAMP.height up obeys, ended at POOL.reach; two pools that meet brighten each other
 *   without ever passing full, so a junction between eight lamps is lit and the middle of a block is not black;
 * - green, the light a lit ground floor spills on the ground before it: every building with shopfronts (the facade's
 *   ground-floor glazing, materials.ts buildingMaterial) and the glass round every room, shop and home. It falls off
 *   as the light of a long lit strip SPILL.height tall does on the ground at its foot, and ends at SPILL.reach;
 * - blue, the floor inside a workplace, under the ceiling its real fixtures hang from (cityLights.ts roomFixtures):
 *   shown only while those are off, so the paint stands in for them and never lies under them;
 * - alpha, the floor inside a shop or a home, whose ceilings show the same lit panels and hang no light at all.
 * Pure: numbers in, bytes out, nothing of three; regionWorld.ts makes the texture and the materials' glow from it.
 * What breaks if it is removed? After dark a lite phone's region is lamp heads and shop windows that light nothing:
 * the streets under them are black, and so is every room.
 */
import { CITY } from '../city.ts'
import { LAMP, lampHead } from '../cityLights.ts'
import { ROOM } from '../interiors.ts'
import type { Pt } from './clip.ts'

/** Metres a texel of the picture covers. */
export const PAINT_TEXEL = 1
/**
 * Metres the picture reaches past the street window on every side. The lamps of the window's outer streets stand on
 * both kerbs, so one row of heads is outside it (by the kerb's 3.9 m less the arm's 1.4 m), and a pool ends POOL.reach
 * from its head: this margin holds all of it, and the picture's outermost texels are written dark whatever stands there
 * (the sampler clamps to them, so nothing is painted past the picture).
 */
export const PAINT_MARGIN = 20
/**
 * A lamp's pool on the ground: where it starts to fade, m from under the head, and where it ends. Inside `fade` it is
 * the cosine-cubed law of a point of light LAMP.height up (poolAt): half at 4.5 m, an eighth at 10 m. The procedural
 * city's painted pool (materials.ts lampPool) is a narrower bell that leaves its junctions dark; a region's picture can
 * afford the lamp's real spread, because it is baked once and costs a frame nothing.
 */
export const POOL = Object.freeze({ fade: 10, reach: 16 })
/** The spill of a lit ground floor: the glazing's height, m (materials.ts: the shopfront's glass ends at 3.9 m), and how far it reaches. */
export const SPILL = Object.freeze({ height: 3.9, reach: 10 })

/** The picture: RGBA bytes, row by row from the origin toward +z, each row toward +x. */
export interface PaintedLight {
  /** The engine metres of the picture's corner (its first texel's outer corner). */
  originX: number
  originZ: number
  /** Texels per edge. */
  size: number
  /** Red the lamps' pools, green the spill, blue the floors under real fixtures, alpha the floors under none. */
  data: Uint8Array<ArrayBuffer>
}

export interface PaintInput {
  /** The street window (region/streets.ts StreetGrid): its corner, engine metres, and its blocks per axis. */
  window: { originX: number; originZ: number; blocks: number }
  /** The lamps as the furniture lists them, [x, z, yaw] (streets.ts windowFurniture). */
  lamps: readonly (readonly [number, number, number])[]
  /** The outer ring of every building whose ground floor is lit glazing, engine metres, wound either way. */
  frontages: readonly (readonly Pt[])[]
  /** The centre of every lot that is a room, a shop or a home (CITY.lotHalf each way, glass all round), and whether
   *  its ceiling hangs real fixtures (a workplace's does: its floor goes to blue; a shop's and a home's go to alpha). */
  interiors: readonly { cx: number; cz: number; fixtures: boolean }[]
}

/**
 * A lamp's light on the ground `d` metres from under its head, 1 under it: cos³ of the angle from the vertical (the
 * inverse square of the slant distance times the cosine of incidence), faded to nothing between POOL.fade and
 * POOL.reach.
 */
export function poolAt(d: number): number {
  return poolAtSquare(d * d)
}

/** poolAt by the distance's square: the bake's inner loop, which takes a root only where the pool fades. */
function poolAtSquare(d2: number): number {
  if (d2 >= POOL.reach * POOL.reach) return 0
  const q = 1 + d2 / (LAMP.height * LAMP.height)
  const law = 1 / (q * Math.sqrt(q))
  if (d2 <= POOL.fade * POOL.fade) return law
  const t = (POOL.reach - Math.sqrt(d2)) / (POOL.reach - POOL.fade)
  return law * t * t * (3 - 2 * t)
}

/** The light of a long lit strip `height` tall on the ground `d` metres from its foot, 1 at the foot. */
const strip = (d: number, height: number): number => 1 - d / Math.sqrt(d * d + height * height)

/** Twice a ring's signed area in (x, z): positive when counter-clockwise (the solid on the left of every edge). */
const area2 = (r: readonly Pt[]): number => {
  let s = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]
  return s
}

/**
 * Bakes the picture. Deterministic: the same window, lamps, frontages and interiors give the same bytes. The cost is
 * about a thousand texels a lamp and a few hundred a wall (a metropolis window: some two thousand lamps and four
 * thousand walls, a few million multiplications in all), once, at boot.
 */
export function bakePaintedLight(input: PaintInput): PaintedLight {
  const { window: w, lamps, frontages, interiors } = input
  const size = Math.round((w.blocks * CITY.pitch + 2 * PAINT_MARGIN) / PAINT_TEXEL)
  const originX = w.originX - PAINT_MARGIN, originZ = w.originZ - PAINT_MARGIN
  const pools = new Float32Array(size * size), spill = new Float32Array(size * size)
  const fixtured = new Float32Array(size * size), bare = new Float32Array(size * size)
  // A texel's centre along one axis, engine metres, and the texels a span covers (clamped to the picture).
  const centre = (i: number, origin: number): number => origin + (i + 0.5) * PAINT_TEXEL
  const span = (lo: number, hi: number, origin: number): [number, number] => [
    Math.max(0, Math.floor((lo - origin) / PAINT_TEXEL)), Math.min(size - 1, Math.ceil((hi - origin) / PAINT_TEXEL) - 1),
  ]

  // The pools.
  for (const lamp of lamps) {
    const [hx, , hz] = lampHead(lamp)
    const [x0, x1] = span(hx - POOL.reach, hx + POOL.reach, originX), [z0, z1] = span(hz - POOL.reach, hz + POOL.reach, originZ)
    for (let z = z0; z <= z1; z++) {
      const row = z * size, dz = centre(z, originZ) - hz
      for (let x = x0; x <= x1; x++) {
        const dx = centre(x, originX) - hx
        const v = poolAtSquare(dx * dx + dz * dz)
        // Two pools that meet: 1 − (1 − a)(1 − b), brighter than either and never past full.
        if (v > 0) pools[row + x] += (1 - pools[row + x]) * v
      }
    }
  }

  // The spill: before every wall, on the side away from the solid, by the distance to the wall (so a convex corner is
  // rounded by its two walls); the brightest wall wins, since two walls of one frontage light one pavement.
  const fade = (d: number): number => {
    const t = Math.min(1, Math.max(0, (SPILL.reach - d) / (0.4 * SPILL.reach)))
    return t * t * (3 - 2 * t)
  }
  const wall = (a: Pt, b: Pt, outLeft: boolean): void => {
    const ex = b[0] - a[0], ez = b[1] - a[1], len = Math.hypot(ex, ez)
    if (!(len > 1e-3)) return
    const ux = ex / len, uz = ez / len
    // Left of the edge is (−ez, ex).
    const nx = outLeft ? -uz : uz, nz = outLeft ? ux : -ux
    // The texels that can be lit: within the reach of the wall on its outer side, so the box of the wall's ends pushed
    // out along the wall and of those pushed out from it.
    const r = SPILL.reach
    const xs = [a[0] - ux * r, b[0] + ux * r, a[0] - ux * r + nx * r, b[0] + ux * r + nx * r]
    const zs = [a[1] - uz * r, b[1] + uz * r, a[1] - uz * r + nz * r, b[1] + uz * r + nz * r]
    const [x0, x1] = span(Math.min(...xs), Math.max(...xs), originX), [z0, z1] = span(Math.min(...zs), Math.max(...zs), originZ)
    for (let z = z0; z <= z1; z++) {
      const pz = centre(z, originZ) - a[1], row = z * size
      for (let x = x0; x <= x1; x++) {
        const px = centre(x, originX) - a[0]
        if (px * nx + pz * nz <= 0) continue
        const t = Math.min(len, Math.max(0, px * ux + pz * uz))
        const ox = px - ux * t, oz = pz - uz * t, d2 = ox * ox + oz * oz
        if (d2 >= r * r) continue
        const d = Math.sqrt(d2)
        const v = strip(d, SPILL.height) * fade(d)
        if (v > spill[row + x]) spill[row + x] = v
      }
    }
  }
  const ring = (r: readonly Pt[]): void => {
    if (r.length < 3) return
    // Counter-clockwise: the solid is on the left of every edge, so the street is on the right.
    const outLeft = !(area2(r) > 0)
    for (let k = 0; k < r.length; k++) wall(r[k], r[(k + 1) % r.length], outLeft)
  }
  for (const r of frontages) ring(r)
  const h = CITY.lotHalf
  for (const { cx, cz } of interiors) ring([[cx - h, cz - h], [cx + h, cz - h], [cx + h, cz + h], [cx - h, cz + h]])

  // The lit floors: inside the glass, with a texel of soft edge.
  const inner = h - ROOM.wall
  for (const { cx, cz, fixtures } of interiors) {
    const floors = fixtures ? fixtured : bare
    const [x0, x1] = span(cx - inner - 1, cx + inner + 1, originX), [z0, z1] = span(cz - inner - 1, cz + inner + 1, originZ)
    for (let z = z0; z <= z1; z++) {
      const dz = Math.abs(centre(z, originZ) - cz), row = z * size
      for (let x = x0; x <= x1; x++) {
        const v = Math.min(1, Math.max(0, inner + 0.5 * PAINT_TEXEL - Math.max(Math.abs(centre(x, originX) - cx), dz)))
        if (v > floors[row + x]) floors[row + x] = v
      }
    }
  }

  const data = new Uint8Array(size * size * 4)
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const i = z * size + x, o = i * 4
      // The outermost texels stay dark: the sampler clamps to them.
      if (x === 0 || z === 0 || x === size - 1 || z === size - 1) continue
      data[o] = Math.round(Math.min(1, pools[i]) * 255)
      data[o + 1] = Math.round(Math.min(1, spill[i]) * 255)
      data[o + 2] = Math.round(Math.min(1, fixtured[i]) * 255)
      data[o + 3] = Math.round(Math.min(1, bare[i]) * 255)
    }
  }
  return { originX, originZ, size, data }
}

/**
 * The picture at a place, engine metres: [pools, spill, floors under fixtures, floors under none], each 0..1, filtered
 * as the GPU's bilinear sampler filters it and clamped to the picture's edge as the sampler is. For the tests and the
 * probes.
 */
export function paintAt(p: PaintedLight, x: number, z: number): [number, number, number, number] {
  const u = (x - p.originX) / PAINT_TEXEL - 0.5, v = (z - p.originZ) / PAINT_TEXEL - 0.5
  const clamp = (i: number): number => Math.max(0, Math.min(p.size - 1, i))
  const x0 = Math.floor(u), z0 = Math.floor(v), tx = u - x0, tz = v - z0
  const at = (ix: number, iz: number, c: number): number => p.data[(clamp(iz) * p.size + clamp(ix)) * 4 + c] / 255
  const out: [number, number, number, number] = [0, 0, 0, 0]
  for (let c = 0; c < 4; c++) {
    const top = at(x0, z0, c) * (1 - tx) + at(x0 + 1, z0, c) * tx
    const bottom = at(x0, z0 + 1, c) * (1 - tx) + at(x0 + 1, z0 + 1, c) * tx
    out[c] = top * (1 - tz) + bottom * tz
  }
  return out
}
