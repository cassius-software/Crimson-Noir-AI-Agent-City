// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It turns the seven homes (01_Initialize_World/properties.ts), what the operator furnished
 * them with (05_Observe_Environment/homeStore.ts) and what the progression says they own into what the page draws and
 * what the realm makes solid. Each home gets its floor overlay and its wall panels in its finish (its defaults until
 * the owner picks others, drawn for every home, owned or not, and in a network room too, so a home never shows the
 * street's ground under it); an owned home gets the pieces of its saved layout that fit and whose line is owned
 * (02_Define_The_Rules/homeLayout.ts fitLayout), and a home on sale gets its show home; while the owner furnishes, the
 * piece in hand is drawn as a ghost where it would go and a marker shows the cursor's cells, lit when the piece fits.
 * All of it is a list of city boxes in the building material's styles for the world's one HomeFurniture mesh
 * (world.ts setHomes). It also gives each home's solid boxes for the realm's 'home' command, the draft camera's eye
 * for the furnishing card, the homes' taglines and the finish-name to style-number map.
 *
 * Every box is made in the room frame (homeLayout.ts) and turned into the city by interiors.ts toWorld, as properties.ts
 * turns a home's shell, so what is drawn, what is solid and what the worker checks (properties.ts checkHomeBoxes) are
 * the same boxes. A home with a sky floor (Home.sky) has a second room, 7 or 8 (homeGrid.ts skyRoom), drawn, made
 * solid and staffed the same way at its floor's height, with the deed's bit deciding between its layout and its show
 * floor. It also says why the ride to or from a sky floor is refused (floorRefusal). It is pure: no three.js, no
 * storage, no engine.
 * What breaks if it is removed? The homes would show the street's ground and bare glass, the furniture would be neither
 * drawn nor solid, the show homes would be empty, and the furnishing card would have no draft to show.
 */
import { STYLE, type Box, type Building } from '../01_Initialize_World/city.ts'
import { acrossDir, doorDir, toWorld, type Side } from '../01_Initialize_World/interiors.ts'
import type { Home } from '../01_Initialize_World/properties.ts'
import { CELL, DEPTH, GRID_HALF, HOME_PIECES, INSET, backEdge, cellCentre, deedOf, planOf, skyRoom } from '../02_Define_The_Rules/homeGrid.ts'
import {
  FLOORS, FURNITURE_BASE, GLASS, OVERLAY, WALLS, fitLayout, floorOverlay, footprint, renderBoxes, solidBox, stagingOf, stationOf, stationsIn, wallPanels,
  type Finish, type Piece, type RoomBox,
} from '../02_Define_The_Rules/homeLayout.ts'
import { finishOf, type HomeRecord } from '../05_Observe_Environment/homeStore.ts'

/** A finish's name (homeLayout.ts FINISHES) to the building material's style number (city.ts STYLE) it is drawn in. */
export const FINISH_STYLE: Readonly<Record<Finish, number>> = Object.freeze({
  concrete: STYLE.concrete,
  deck: STYLE.deck,
  trim: STYLE.trim,
  masonry: STYLE.masonry,
  rail: STYLE.rail,
  lit: STYLE.lit,
  planted: STYLE.planted,
})

/**
 * The most boxes homeInstances returns: world.ts HOME_INSTANCES, the HomeFurniture mesh's capacity (homeView.test.ts
 * holds the two equal; this file stays clear of three.js). Seven homes of a floor, five panels and sixteen pieces of at
 * most four boxes make 490, the two sky floors of a floor and sixteen pieces 130 more, and the draft's ghost and cursor
 * five more: 625.
 */
export const HOME_BOXES = 640

/**
 * The seven homes' taglines, by property index (the deed view of the home card, HomeCard.tsx): one sentence each, every
 * one passing the conduct screen, unarmed and naming no real place (homeView.test.ts).
 */
export const CITY_LINES: readonly string[] = Object.freeze([
  'One bright room that costs nothing to claim: the first home any operator can call their own.',
  'Brick walls and old-city manners: the classic first step up from a single room.',
  'Warm timber and wide glass, with room to host friends on long evenings.',
  'A polished residence for an operator on the rise, with a tower\'s name on the deed.',
  'Glass on every side and space to spare, for an operator who likes the light.',
  'A deep, quiet house with space enough to host the whole team.',
  'The grandest home in the city, kept for an operator at the very top of the ladder.',
])

/** A room's name: the deed's for a hall, and the deed's with " · sky floor" for a sky floor (rooms 7 and 8). */
export const roomName = (name: string, room: number): string => (room >= DEPTH.length ? `${name} · sky floor` : name)

/** Where a sky floor stands for the card (engine.ts floorWhere): whether the ride goes up (from the hall), how far up the floor is (m, rounded), and why it cannot go now (null: it can). */
export interface FloorWhere { readonly up: boolean; readonly metres: number; readonly why: string | null }

/**
 * Why the ride to or from a sky floor is refused now, in the card's words, or null when it may go: the first that
 * applies of a stopped city, no sky floor in this map, a network room (its authority replays the walk and would put the
 * player back), at the wheel, and not standing in the room the ride leaves from.
 */
export function floorRefusal(o: { stopped: boolean; floor: boolean; shared: boolean; up: boolean; driving: boolean; inside: boolean }): string | null {
  if (o.stopped) return 'The city has stopped'
  if (!o.floor) return 'This home has no sky floor in this map'
  if (o.shared) return `Going ${o.up ? 'up' : 'down'} waits until you leave the shared room: it replays your walk and would put you back`
  if (o.driving) return 'Step out of the car first'
  if (!o.inside) return 'Walk into the home first'
  return null
}

/**
 * The furnishing draft the card hands the engine (engine.ts setHomeDraft): the room being furnished, the cursor's cell,
 * the piece in hand (drawn as a ghost with its footprint's lowest cell on the cursor; null: nothing in hand), whether
 * canPlace said 'ok' for it there, and which side the draft camera looks from (0 the doorway, 1 the +v wall, 2 the
 * back, 3 the −v wall).
 */
export interface Draft { home: number; cursor: { c: number; r: number }; piece: Piece | null; ok: boolean; view: 0 | 1 | 2 | 3 }

/** The cursor marker: how far inside its cells' edges it stands (inside a ghost's sides, so no face is shared), and its bottom and top over the overlay's top, m. */
export const CURSOR = Object.freeze({ inset: 0.03, gap: 0.003, rise: 0.015 })

/** The draft camera (furnishEye): how far from the cursor it stands, how far inside the room's faces it is kept, its height under the 4.2 m slab and the height it looks at, m. */
export const EYE = Object.freeze({ distance: 5.2, margin: 0.35, height: 3.6, look: 0.5 })

/** Each view's way from the cursor to the eye in the room frame (u toward the doorway, v across): the doorway, +v, the back, −v. */
const VIEW_WAY: readonly (readonly [number, number])[] = Object.freeze([[1, 0], [0, 1], [-1, 0], [0, -1]])

/** A room frame: the lot's centre and the doorway's street front (a Home is one). */
type Frame = { cx: number; cz: number; side: Side }

/** Whether bit `bit` of `mask` is set (a bit outside 0..31 never is). */
const has = (mask: number, bit: number): boolean => Number.isInteger(bit) && bit >= 0 && bit < 32 && ((mask >>> bit) & 1) === 1

/** A room-frame box [u0, v0, u1, v1, y0, y1] of a home as a city box [x0, y0, z0, x1, y1, z1]: properties.ts worldBox's turn. */
export function worldBoxOf(frame: Frame, b: RoomBox): Box {
  const p = toWorld(frame, b[0], b[1]), q = toWorld(frame, b[2], b[3])
  return [Math.min(p.x, q.x), b[4], Math.min(p.z, q.z), Math.max(p.x, q.x), b[5], Math.max(p.z, q.z)]
}

/**
 * The pieces drawn and made solid in room `home`: while its deed is owned (bit deedOf(home) of `deedMask`), its saved
 * layout fitted by fitLayout with the lines owned (bit id − 160 of `lineMask`), the pieces that fit (the rest stay in
 * the record as "not placed here"); while it is on sale, its show home (homeLayout.ts stagingOf), which leaves on purchase.
 */
export function homePlaced(home: number, record: HomeRecord, deedMask: number, lineMask: number): readonly Piece[] {
  if (!has(deedMask, deedOf(home))) return stagingOf(home)
  return fitLayout(home, record[home]?.pieces ?? [], (id) => has(lineMask, id - FURNITURE_BASE)).placed
}

/**
 * Every room of `homes`: each hall (its property index) on `base`, its pieces from the ground, then each sky floor
 * (its room) on its floor, its pieces from there.
 */
function roomsOf<H extends Home>(homes: readonly H[], base: number): { h: H; room: number; base: number; lift: number }[] {
  return [...homes.map((h) => ({ h, room: h.home, base, lift: 0 })), ...homes.flatMap((h) => (h.sky ? [{ h, room: skyRoom(h.home), base: h.sky.y, lift: h.sky.y }] : []))]
}

/** One post as the engine keeps it (App over staffStore.ts and the roster): where, whether they stand there now, and how they are dressed. */
export interface StaffPost {
  readonly name: string; readonly home: number; readonly c: number; readonly r: number
  /** False while the agent is hired (out with the player): kept, listed, not drawn. */
  readonly present: boolean
  /** Body variant 0..3 (look.ts LOOK_BODIES), top colour 0xRRGGBB (lookSwatch 'top'), height factor (heightScale). */
  readonly body: number; readonly ink: number; readonly scale: number
}

/**
 * One workstation of an owned home, read-only (engine.ts homeSeats). kind, name and door fit 08_Swarm/team.ts
 * TeamRoom: kind is `homeSeat:<room>:<c>:<r>`, stable while that workstation stands at that cell; door is the home's arrival on the sidewalk lane, never inside the lot; `at` is where a posted agent stands,
 * inside the lot, at the floor's overlay height (a sky floor's high up), with the yaw that faces the screen. home is
 * the room (a hall's property index, or 7 and 8 for the sky floors). seat numbers the room's workstations from 1 in
 * reading order (back row first, then left to right).
 */
export interface HomeSeat {
  readonly kind: string
  readonly name: string
  readonly door: { readonly x: number; readonly z: number }
  readonly home: number
  readonly seat: number
  readonly c: number
  readonly r: number
  readonly at: { readonly x: number; readonly y: number; readonly z: number; readonly yaw: number }
  readonly occupant: string | null
  readonly present: boolean
}

/**
 * Every workstation the homes draw (homePlaced) in each room whose deed is owned, the halls first and then the sky
 * floors, with who is posted at it; none in a network room, whose realm keeps every piece off. A show home's pieces are
 * never listed (its deed is not owned).
 */
export function homeSeats(
  homes: readonly (Home & { readonly name: string; readonly arrival: { readonly x: number; readonly z: number } })[],
  record: HomeRecord, deedMask: number, lineMask: number, posts: readonly StaffPost[], o: { room: boolean; base: number },
): readonly HomeSeat[] {
  const out: HomeSeat[] = []
  for (const { h, room, base } of o.room ? [] : roomsOf(homes, o.base)) {
    if (!has(deedMask, h.home)) continue
    const d = doorDir(h.side), a = acrossDir(h.side)
    stationsIn(homePlaced(room, record, deedMask, lineMask)).forEach((p, i) => {
      const s = stationOf(p)!, w = toWorld(h, s.u, s.v)
      const post = posts.find((x) => x.home === room && x.c === p.c && x.r === p.r)
      out.push(Object.freeze({
        kind: `homeSeat:${room}:${p.c}:${p.r}`, name: `${roomName(h.name, room)}, workstation ${i + 1}`, door: Object.freeze({ ...h.arrival }),
        home: room, seat: i + 1, c: p.c, r: p.r,
        at: Object.freeze({ x: w.x, y: base + OVERLAY.y1, z: w.z, yaw: Math.atan2(s.fu * d.x + s.fv * a.x, s.fu * d.z + s.fv * a.z) }),
        occupant: post?.name ?? null, present: post?.present ?? false,
      }))
    })
  }
  return Object.freeze(out)
}

/** One figure staffView.ts draws: feet at (x, y, z), facing (sin yaw, cos yaw), body variant, top colour, height factor. */
export interface StaffFigure { readonly x: number; readonly y: number; readonly z: number; readonly yaw: number; readonly body: number; readonly ink: number; readonly scale: number }

/** The figures staffView.ts draws: one per seat whose posted agent stands there now, in their dress. */
export function staffFigures(seats: readonly HomeSeat[], posts: readonly StaffPost[]): StaffFigure[] {
  const out: StaffFigure[] = []
  for (const s of seats) {
    const p = s.present && posts.find((x) => x.home === s.home && x.c === s.c && x.r === s.r)
    if (p) out.push({ ...s.at, body: p.body, ink: p.ink, scale: p.scale })
  }
  return out
}

/**
 * What the world's HomeFurniture mesh draws (world.ts setHomes), as city boxes and style numbers, in order: for each
 * room of `homes` (the halls, then the sky floors), its floor overlay `o.base` up (0 in the city, the region's paved
 * floor in a region; a sky floor's own height) in its floor finish and a hall's wall panels in its wall finish
 * (homeStore.ts finishOf: the record's, or the room's defaults), always, a network room included; then its pieces
 * (homePlaced, a sky floor's raised to its floor), except in a network room (`o.room`), which knows nothing of them.
 * Last comes the draft's (never in a network room, where nothing is furnished): the ghost of the piece in hand at the
 * cursor in its own finishes, only when it fits there (`ok`), and the cursor marker, a thin box over the overlay across
 * the piece's footprint (one cell with nothing in hand), lit when `ok` and dark steel when not. At most HOME_BOXES boxes.
 */
export function homeInstances(homes: readonly Home[], record: HomeRecord, deedMask: number, lineMask: number, o: { room: boolean; base: number; draft: Draft | null }): Building[] {
  const out: Building[] = []
  const put = (h: Frame, box: RoomBox, finish: Finish, lift = 0) => out.push({ box: worldBoxOf(h, [box[0], box[1], box[2], box[3], box[4] + lift, box[5] + lift]), style: FINISH_STYLE[finish] })
  const rooms = roomsOf(homes, o.base)
  for (const { h, room, base, lift } of rooms) {
    const { floor, wall } = finishOf(record, room)
    put(h, floorOverlay(room, base), FLOORS[floor]?.style ?? 'concrete')
    const panels = WALLS[wall]?.style ?? null
    if (panels !== null) for (const box of wallPanels(room, wall)) put(h, box, panels)
    if (o.room) continue
    for (const p of homePlaced(room, record, deedMask, lineMask)) for (const part of renderBoxes(p)) put(h, part.box, part.finish, lift)
  }
  const d = o.draft
  const at = d && !o.room ? rooms.find((x) => x.room === d.home) : undefined
  if (d && at) {
    const { h, lift } = at, plan = planOf(at.room)!
    const ghost: Piece | null = d.piece && { id: d.piece.id, c: d.cursor.c, r: d.cursor.r, rot: d.piece.rot }
    if (ghost && d.ok) for (const part of renderBoxes(ghost)) put(h, part.box, part.finish, lift)
    const f = (ghost && footprint(ghost)) ?? { c: d.cursor.c, r: d.cursor.r, cols: 1, rows: 1 }
    // Kept to the room's floor plan: a footprint that runs off it (canPlace said 'outside') stops at its edge.
    const line = (n: number) => -GRID_HALF + n * CELL
    const u0 = Math.max(line(plan.r0), line(f.r)) + CURSOR.inset, u1 = Math.min(line(plan.r1 + 1), line(f.r + f.rows)) - CURSOR.inset
    const v0 = Math.max(line(plan.c0), line(f.c)) + CURSOR.inset, v1 = Math.min(line(plan.c1 + 1), line(f.c + f.cols)) - CURSOR.inset
    const top = at.base + OVERLAY.y1
    if (u1 > u0 && v1 > v0) put(h, [u0, v0, u1, v1, top + CURSOR.gap, top + CURSOR.rise], d.ok ? 'lit' : 'rail')
  }
  return out.length > HOME_BOXES ? out.slice(0, HOME_BOXES) : out
}

/**
 * A room's solid boxes for the realm's 'home' command (simProtocol.ts { c: 'home', index, boxes }): each piece's one
 * collider (homeLayout.ts solidBox, inside its cells, from the floor) turned into the city and raised by `base` (a sky
 * floor's height; 0 in a hall), six numbers a box (x0, y0, z0, x1, y1, z1), at most HOME_PIECES boxes. Every box passes
 * properties.ts checkHomeBoxes for the room's frame.
 */
export function homeSolids(home: Home, placed: readonly Piece[], base = 0): number[] {
  const out: number[] = []
  for (const p of placed.slice(0, HOME_PIECES)) {
    const b = solidBox(p)
    if (b) out.push(...worldBoxOf(home, [b[0], b[1], b[2], b[3], b[4] + base, b[5] + base]))
  }
  return out
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

/**
 * The draft camera over the cursor's cell in room `room` of `home` (engine.ts poses it in present()): the eye
 * EYE.distance from the cell's centre toward the view's side (0 the doorway, 1 the +v wall, 2 the back, 3 the −v wall),
 * kept EYE.margin inside the glass's inner faces and the fill block's face (a shallow home's back; a sky floor's glass
 * on all four sides), at EYE.height under the slab; it looks at the cell's centre at EYE.look. Both are over the
 * room's floor (a sky floor's height). City metres.
 */
export function furnishEye(home: Home, cell: { c: number; r: number }, view: 0 | 1 | 2 | 3, room = home.home): { eye: { x: number; y: number; z: number }; at: { x: number; y: number; z: number } } {
  const sky = room >= DEPTH.length ? home.sky?.y ?? 0 : 0
  const back = backEdge(room) - INSET + EYE.margin, front = (room >= DEPTH.length ? INSET - backEdge(room) : GLASS) - EYE.margin
  const centre = cellCentre(cell.c, cell.r)
  const u = clamp(centre.u, back, front), v = clamp(centre.v, -front, front)
  const [du, dv] = VIEW_WAY[view] ?? VIEW_WAY[0]
  const e = toWorld(home, clamp(u + du * EYE.distance, back, front), clamp(v + dv * EYE.distance, -front, front))
  const a = toWorld(home, u, v)
  return { eye: { x: e.x, y: sky + EYE.height, z: e.z }, at: { x: a.x, y: sky + EYE.look, z: a.z } }
}
