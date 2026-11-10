// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one definition of a home's floor plan (01_Initialize_World/properties.ts): the
 * square grid of cells a home is furnished on, how deep each of the seven homes is in rows of that grid, and the apron
 * in front of the doorway that nothing is ever placed on. The page builds each home's fill block from these numbers
 * (a smaller home is a shallower room, with a solid block behind it), and the physics worker reaches the same file
 * through city.ts, so both read one room. It is pure and imports nothing.
 *
 * The grid lies in the room frame of interiors.ts (u from the back wall to the doorway, v across): GRID cells of CELL
 * metres each way, centred on the lot, its edges INSET inside the glass's inner faces (and the same distance in front
 * of the fill block's face in a shallower home). Row 0 is the back and row GRID − 1 the doorway; column c grows toward
 * +v, which is on the right when you look in from the door. Home i uses rows GRID − DEPTH[i] to GRID − 1, every column.
 *
 * These numbers are shipped data, like the catalogue's bits: a saved layout names cells by (column, row), so GRID,
 * CELL, DEPTH and APRON keep their meaning for ever, and homeGrid.test.ts pins them.
 * What breaks if it is removed? The homes have no depth, the fill blocks no face, and a furnished layout would have no
 * frame to be saved in or drawn from.
 */

/** Cells along each side of the grid. */
export const GRID = 32
/** One cell's side, m: wider than a person's capsule (two radii and two centimetres of skin), so one free cell is a path. */
export const CELL = 0.778
/** Half the grid's side, m (GRID · CELL / 2): its edges in the room frame are at u and v = ±GRID_HALF. */
export const GRID_HALF = 12.448
/** How far the grid's edges sit inside the glass's inner faces (at ±12.5) and in front of a fill block's face, m. */
export const INSET = 0.052
/**
 * Each home's depth in rows, by property index (the micro-loft first, the two grandest last): never shrinking from one
 * home to the next, and the full grid for the two grandest. The homes are 9.3, 12.4, 15.6, 18.7, 21.8, 24.9 and
 * 24.9 m deep, and all 24.9 m wide.
 */
export const DEPTH: readonly number[] = Object.freeze([12, 16, 20, 24, 28, 32, 32])
/**
 * The apron, in rows and columns (both ends included): the cells in front of the 4 m doorway (u 9.336 to 12.448,
 * |v| up to 2.334). It is always free, so the way in from the doorway is never blocked.
 */
export const APRON: Readonly<{ r0: number; r1: number; c0: number; c1: number }> = Object.freeze({ r0: 28, r1: 31, c0: 13, c1: 18 })
/** The most pieces a home holds (one collider each), the same as a workplace's furniture (interiors.ts ROOM.furniture). */
export const HOME_PIECES = 16

/** The u of home `home`'s first row's back edge, m: the room's back face (its fill block's, or the glass's) is INSET behind it. */
export function backEdge(home: number): number {
  return -GRID_HALF + (GRID - DEPTH[home]) * CELL
}

/** The centre of cell (c, r) in the room frame, m. */
export function cellCentre(c: number, r: number): { u: number; v: number } {
  return { u: -GRID_HALF + (r + 0.5) * CELL, v: -GRID_HALF + (c + 0.5) * CELL }
}

/** Whether cell (c, r) is in home `home`'s floor plan: whole numbers on the grid, at or in front of its first row. */
export function inMask(home: number, c: number, r: number): boolean {
  const depth = DEPTH[home]
  if (depth === undefined || !Number.isInteger(c) || !Number.isInteger(r)) return false
  return c >= 0 && c < GRID && r >= GRID - depth && r < GRID
}

/** Whether cell (c, r) is in the apron. */
export function inApron(c: number, r: number): boolean {
  return Number.isInteger(c) && Number.isInteger(r) && r >= APRON.r0 && r <= APRON.r1 && c >= APRON.c0 && c <= APRON.c1
}
