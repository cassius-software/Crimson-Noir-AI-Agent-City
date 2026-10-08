// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? A region built from surveyed data (the world compiler, region/compile.ts) needs one flat,
 * metric frame the whole engine can share: this is it. A transverse Mercator on the GRS 1980 ellipsoid (the NAD83
 * datum the sources use), true to scale along its central meridian, turned into the engine's axes: x east, z SOUTH
 * (the lake lies toward +z, as in the procedural city), metres from the region's origin.
 * - The formulas are the ellipsoidal series of the USGS projection manual (Snyder 1987, pp. 60–64). Along the central
 *   meridian they are the meridian arc itself (checked to 0.1 mm over 55 km); within 1.2° of it, forward and inverse
 *   agree with each other to a fraction of a millimetre.
 * - Across a region 150 km wide the scale grows by at most 0.03 % toward its edges (a lamp post stays a lamp post).
 * What breaks if it is removed? Roads, water and buildings from different sources would not line up, and nothing
 * could be placed in the region by its surveyed position.
 */

/** GRS 1980. */
const A = 6378137
const F = 1 / 298.257222101
const E2 = F * (2 - F)
const EP2 = E2 / (1 - E2)
const E4 = E2 * E2, E6 = E4 * E2
const M1 = 1 - E2 / 4 - (3 * E4) / 64 - (5 * E6) / 256
const M2 = (3 * E2) / 8 + (3 * E4) / 32 + (45 * E6) / 1024
const M3 = (15 * E4) / 256 + (45 * E6) / 1024
const M4 = (35 * E6) / 3072
const E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2))
const RAD = Math.PI / 180

/** A region's frame: its origin (the central meridian runs through it) and the scale on that meridian. */
export interface Grid {
  readonly lon0: number
  readonly lat0: number
  readonly k0: number
}

/** Distance along the meridian from the equator to latitude φ (radians), m. */
function meridian(phi: number): number {
  return A * (M1 * phi - M2 * Math.sin(2 * phi) + M3 * Math.sin(4 * phi) - M4 * Math.sin(6 * phi))
}

/** Longitude, latitude (degrees) to the engine's x (east) and z (south), metres from the grid's origin. */
export function toGrid(g: Grid, lon: number, lat: number): { x: number; z: number } {
  const phi = lat * RAD
  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi)
  const N = A / Math.sqrt(1 - E2 * s * s)
  const T = t * t, C = EP2 * c * c
  const a = (lon - g.lon0) * RAD * c
  const a2 = a * a, a3 = a2 * a, a4 = a3 * a, a5 = a4 * a, a6 = a5 * a
  const x = g.k0 * N * (a + ((1 - T + C) * a3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * a5) / 120)
  const y = g.k0 * (meridian(phi) - meridian(g.lat0 * RAD) +
    N * t * (a2 / 2 + ((5 - T + 9 * C + 4 * C * C) * a4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * a6) / 720))
  return { x, z: -y }
}

/** The engine's x (east) and z (south), metres from the grid's origin, to longitude and latitude (degrees). */
export function fromGrid(g: Grid, x: number, z: number): { lon: number; lat: number } {
  const mu = (meridian(g.lat0 * RAD) + -z / g.k0) / (A * M1)
  const p1 = mu + ((3 * E1) / 2 - (27 * E1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * E1 * E1) / 16 - (55 * E1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * E1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * E1 ** 4) / 512) * Math.sin(8 * mu)
  const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1)
  const C1 = EP2 * c * c, T1 = t * t
  const N1 = A / Math.sqrt(1 - E2 * s * s)
  const R1 = (A * (1 - E2)) / (1 - E2 * s * s) ** 1.5
  const D = x / (N1 * g.k0)
  const D2 = D * D, D3 = D2 * D, D4 = D3 * D, D5 = D4 * D, D6 = D5 * D
  const phi = p1 - ((N1 * t) / R1) * (D2 / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D4) / 24 +
    ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D6) / 720)
  const lam = (D - ((1 + 2 * T1 + C1) * D3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D5) / 120) / c
  return { lon: g.lon0 + lam / RAD, lat: phi / RAD }
}

/** The scale factor at a point: how many engine metres one ground metre is there (1 on the central meridian). */
export function scaleAt(g: Grid, lon: number, lat: number): number {
  const phi = lat * RAD
  const c = Math.cos(phi)
  const a = (lon - g.lon0) * RAD * c
  const C = EP2 * c * c
  return g.k0 * (1 + ((1 + C) * a * a) / 2 + ((5 - 4 * Math.tan(phi) ** 2 + 42 * C + 13 * C * C - 28 * EP2) * a ** 4) / 24)
}
