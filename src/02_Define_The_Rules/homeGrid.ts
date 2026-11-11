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
 * A home is furnished room by room. Rooms 0 to 6 are the homes' halls, by property index; rooms 7 and 8 are the sky
 * floors up the towers of the Penthouse and the Sky-Mansion (SKY_HOMES), in the city only (properties.ts). Both sky
 * floors use one fixed plan of the same grid, SKY: 20 by 20 cells round the lot's centre, with the arrival block
 * (ARRIVAL) kept clear in front of where the ride up puts the player, as the apron is in a hall.
 *
 * These numbers are shipped data, like the catalogue's bits: a saved layout names cells by (column, row), so GRID,
 * CELL, DEPTH, APRON, SKY and ARRIVAL keep their meaning for ever, and homeGrid.test.ts pins them.
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

/** The homes with a sky floor up their tower in the city, by property index: the Penthouse's is room 7, the Sky-Mansion's room 8. */
export const SKY_HOMES: readonly number[] = Object.freeze([3, 6])
/** How many rooms there are: the seven halls, then the two sky floors. */
export const ROOM_COUNT = DEPTH.length + SKY_HOMES.length
/** The property index (the deed) room `room` belongs to: a hall's own index, a sky floor's home's; −1 for no room. */
export const deedOf = (room: number): number => (room < DEPTH.length ? room : SKY_HOMES[room - DEPTH.length] ?? -1)
/** Home `home`'s sky floor's room (7 or 8), or −1 for a home without one. */
export const skyRoom = (home: number): number => (SKY_HOMES.includes(home) ? DEPTH.length + SKY_HOMES.indexOf(home) : -1)

/** A block of cells, both ends included. */
export type Cells = Readonly<{ r0: number; r1: number; c0: number; c1: number }>
/** A room's floor plan: its rows and columns, and the block kept clear for the way in (the apron, or the arrival). */
export type Plan = Readonly<{ r0: number; r1: number; c0: number; c1: number; keep: Cells }>
/**
 * The arrival on a sky floor (u 4.668 to 7.78, |v| up to 2.334): the cells in front of the glass on the doorway's side,
 * where the ride up puts the player (its centre, u 6.224, v 0). It is always free, as the apron is.
 */
export const ARRIVAL: Cells = Object.freeze({ r0: 22, r1: 25, c0: 13, c1: 18 })
/** The sky floors' plan: rows and columns 6 to 25, 15.56 m square round the lot's centre (u and v ±7.78), the glass INSET outside it. */
export const SKY: Plan = Object.freeze({ r0: 6, r1: 25, c0: 6, c1: 25, keep: ARRIVAL })
const HALLS: readonly Plan[] = Object.freeze(DEPTH.map((d) => Object.freeze({ r0: GRID - d, r1: GRID - 1, c0: 0, c1: GRID - 1, keep: APRON })))

/** Room `room`'s floor plan: a hall's rows GRID − DEPTH to GRID − 1 and every column, or SKY; null for no room. */
export function planOf(room: number): Plan | null {
  return !Number.isInteger(room) || room < 0 ? null : HALLS[room] ?? (room < ROOM_COUNT ? SKY : null)
}

/** The u of room `room`'s first row's back edge, m: the room's back face (its fill block's, or the glass's) is INSET behind it. */
export function backEdge(home: number): number {
  return -GRID_HALF + (planOf(home)?.r0 ?? NaN) * CELL
}

/** The centre of cell (c, r) in the room frame, m. */
export function cellCentre(c: number, r: number): { u: number; v: number } {
  return { u: -GRID_HALF + (r + 0.5) * CELL, v: -GRID_HALF + (c + 0.5) * CELL }
}

/** Whether whole-numbered cell (c, r) lies in block `b`. */
const within = (b: Cells | null | undefined, c: number, r: number): boolean =>
  !!b && Number.isInteger(c) && Number.isInteger(r) && r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1

/** Whether cell (c, r) is in room `home`'s floor plan: whole numbers inside its rows and columns. */
export function inMask(home: number, c: number, r: number): boolean {
  return within(planOf(home), c, r)
}

/** Whether cell (c, r) is in the apron. */
export function inApron(c: number, r: number): boolean {
  return within(APRON, c, r)
}

/** Whether cell (c, r) is in the block room `room` keeps clear: a hall's apron, a sky floor's arrival. */
export function inKeep(room: number, c: number, r: number): boolean {
  return within(planOf(room)?.keep, c, r)
}
