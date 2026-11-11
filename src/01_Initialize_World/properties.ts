// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the city's seven homes, the properties the design house's brokerage sells deeds for:
 * a micro-loft by the elevated loop's south platform, a brownstone on the heritage seam, a timber loft by the pier, a
 * penthouse and a sky-mansion at the foot of two headquarters towers, and a glass villa and an estate on the lakefront
 * row. Each is a ground-floor room on a lot of its own that anyone walks into through its doorway. Everything here is
 * pure and seeded: which lots, which way each doorway faces, the shell, the fill block that makes a smaller home a
 * shallower room, and the two planters in the doorway.
 *
 * A home is built from the shop's recipe (storefronts.ts shopsAt): the lot's podium becomes floor-to-ceiling glass
 * walls ROOM.wall thick with a doorway ROOM.door wide either side of its axis, and a ceiling slab in the podium's own
 * finish that carries the tower above. The room frame is the workplaces' (interiors.ts toWorld), so insideRoom serves a
 * home as it is, and the floor plan is homeGrid.ts's. Behind a home shallower than the grid stands one solid fill block,
 * so the lot stays solid behind the room for everything that treats a lot as solid. Two concrete planters stand in the
 * doorway band: a person walks between them, and no car fits through any of the three gaps, so no car is ever inside a
 * home and the realm needs nothing new for one.
 *
 * The lots are picked after the workplaces' (interiors.ts workplaceLots) and the shops' (storefronts.ts shopLots) of
 * the same seed, never one of theirs, so neither picker changes; the dice are a stream of their own. No name is read
 * here: the page reads each deed's name from the catalogue (deed id DEED_BASE + the property index), so the catalogue
 * and the wardrobe stay out of the physics worker, which reaches this file through city.ts.
 *
 * In the city the Penthouse and the Sky-Mansion also have a sky floor (Home.sky): their tower's box is cut at a floor
 * high up and replaced, in its place in the city's order, by the tower below it, a band of clear panes (STYLE.clear:
 * they collide but are never drawn) between rail mullions round a fixed 15.6 m room on the lot's centre (homeGrid.ts
 * SKY), a trim slab over the room, and the tower above it. The worker, the page and the network room's authority all
 * build from the same boxes (city.ts generateCity), so the floor stands in all three. A region's homes have none.
 *
 * The worker also checks a home's furniture here (homeFrames, skyFrames, checkHomeBoxes): the page sends each room's
 * solid boxes in city metres (simCore.ts 'home'), and each one must stand inside that room's floor plan, on its floor,
 * under its ceiling, tall enough not to be stepped onto, and off the apron in front of the doorway (a sky floor's
 * arrival). Nothing else about the furniture is known here, so this file stays fit for the worker.
 * What breaks if it is removed? The deeds have no homes to stand for: nothing to walk into, nowhere to go home to.
 */
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import { CELL, DEPTH, GRID, GRID_HALF, HOME_PIECES, INSET, SKY, backEdge, planOf, skyRoom } from '../02_Define_The_Rules/homeGrid.ts'
// city.ts imports hollowProperties back: a cycle, safe because neither module reads the other at load (every use is in a function).
import { CITY, CITY_CENTER, HERITAGE_COLUMNS, STYLE, cityPlan, districtOfLot, type Box, type Building } from './city.ts'
import { ROOM, doorDir, insideRoom, toLocal, toWorld, workplaceLots, type RoomCanvas, type Side } from './interiors.ts'
import { shopLots } from './storefronts.ts'

/** The seven property kinds, in a fixed order: the index is the property's bit, and its deed's id is DEED_BASE + index. */
export const PROPERTY_KINDS = ['microLoft', 'brownstone', 'timberLoft', 'penthouse', 'glassVilla', 'estate', 'skyMansion'] as const
export type PropertyKind = (typeof PROPERTY_KINDS)[number]

/** The catalogue id of the first property's deed (storeCatalog.ts): home i's deed is DEED_BASE + i. */
export const DEED_BASE = 224

/** A home's tuning, frozen: numbers only, in the room frame. */
export const HOME = Object.freeze({
  /**
   * The two planters, either side of the doorway's axis: u from u0 to u1 (inside the doorway band, which runs from the
   * glass's inner face at 12.5 to its outer face at 13, and touching neither), |v| from v0 to v1, and their height. The
   * gaps are 1.2 m in the centre and 1.1 m at each side, against a person's 0.64 m and a car's 1.76 m.
   */
  planter: Object.freeze({ u0: 12.55, u1: 12.95, v0: 0.6, v1: 0.9, height: 0.9 }),
} as const)

/** A home's lot: its property index (PROPERTY_KINDS), the lot (between streets k and k + 1, m and m + 1) and its doorway's street front. */
export interface HomeLot { home: number; k: number; m: number; side: Side }

export interface Home {
  /** The property index (PROPERTY_KINDS), the same in every map. */
  home: number
  kind: PropertyKind
  k: number
  m: number
  /** The lot's centre, city metres. */
  cx: number
  cz: number
  side: Side
  /** The doorway's centre on the wall's outer face. */
  door: { x: number; z: number }
  /** The room's depth in rows of the floor plan (homeGrid.ts DEPTH). */
  depth: number
  /** The u of the floor plan's back edge in the room frame (homeGrid.ts backEdge): the room's back face is INSET behind it. */
  back: number
  /** The shell: the four glass walls (the doorway's split in two) and the ceiling slab up to the podium's top. */
  shell: Building[]
  /** The fill block behind a room shallower than the grid (none in the two grandest homes), then the two planters. */
  fixtures: Building[]
  /** The sky floor, for homes 3 and 6 in the city: its floor height and the boxes that replaced the tower; null elsewhere. */
  sky: { y: number; boxes: Building[] } | null
}

const key = ({ k, m }: { k: number; m: number }) => `${k},${m}`

/** A lot's podium: the first box of the city that stands from the ground over exactly the whole lot (the test hollowShops makes). */
interface Podium { at: number; top: number; style: number }

/** Every lot's podium in one pass over the boxes, by lot: the first box from the ground that covers exactly that lot. */
function lotPodiums(buildings: readonly Building[]): Map<string, Podium> {
  const P = CITY.pitch, h = CITY.lotHalf
  const out = new Map<string, Podium>()
  buildings.forEach(({ box: [x0, y0, z0, x1, y1, z1], style }, at) => {
    if (y0 !== 0) return
    const k = Math.floor((x0 + x1) / 2 / P), m = Math.floor((z0 + z1) / 2 / P)
    const cx = (k + 0.5) * P, cz = (m + 0.5) * P
    if (x0 === cx - h && x1 === cx + h && z0 === cz - h && z1 === cz + h && !out.has(`${k},${m}`)) out.set(`${k},${m}`, { at, top: y1, style })
  })
  return out
}

/**
 * The headquarters towers standing on their podiums, by lot, with their tops: a downtown lot inside the outer streets
 * (k from HERITAGE_COLUMNS to the last column, m above the lakefront row) whose box starts exactly at its podium's top,
 * is centred on the lot, is 8 to 11.5 m from its centre to each face and at least 70 m tall. That is exactly the tower
 * city.ts downtownLot raises; its four-building branch never stands on the lot's centre. `at` is the tower's index.
 */
function hqTowers(buildings: readonly Building[], podiums: ReadonlyMap<string, Podium>): { k: number; m: number; top: number; at: number }[] {
  const P = CITY.pitch, lake = CITY.blocks - 2, eps = 1e-9
  const out = new Map<string, { k: number; m: number; top: number; at: number }>()
  buildings.forEach(({ box: [x0, y0, z0, x1, y1, z1] }, at) => {
    if (y0 === 0 || y1 - y0 < 70) return
    const bx = (x0 + x1) / 2, bz = (z0 + z1) / 2
    const k = Math.floor(bx / P), m = Math.floor(bz / P)
    if (k < 0 || k >= CITY.blocks || m < 0 || m >= lake || districtOfLot(k, m) !== 'downtown') return
    const p = podiums.get(`${k},${m}`)
    if (!p || y0 !== p.top) return
    if (Math.abs(bx - (k + 0.5) * P) > eps || Math.abs(bz - (m + 0.5) * P) > eps) return
    const w = (x1 - x0) / 2, d = (z1 - z0) / 2
    if (w < 8 - eps || w > 11.5 + eps || d < 8 - eps || d > 11.5 + eps) return
    const was = out.get(`${k},${m}`)
    if (!was || y1 > was.top) out.set(`${k},${m}`, { k, m, top: y1, at })
  })
  return [...out.values()]
}

/**
 * The seed's home lots, one per property, in PROPERTY_KINDS order, read from the city's boxes after the workplaces and
 * the shops are hollowed (`buildings`, as city.ts cityPlan has them then). A lot is free when it still has its podium
 * and no workplace, shop or earlier home took it. The picks go in the order 0, 1, 2, 4, 5, 6, 3, the most constrained
 * lists first, and the dice (createRng(seed ^ 0x40e5f00d)) are drawn exactly three times, in that order: the
 * brownstone's row, the sky-mansion's doorway and the penthouse's.
 * - 0, the micro-loft: the first free lot flanking one of the elevated loop's four platforms (06_Make_Decisions/tracks.ts
 *   trainLoops: the loop over streets 4 and 12 both ways, a platform mid-block on each side, at x 300 on street m = 4,
 *   z 300 on k = 12, x 340 on m = 12 and z 340 on k = 4), its doorway toward the loop's street. The heritage lot west
 *   of the last platform is never used, and the workplaces and shops can take at most six of the seven.
 * - 1, the brownstone: the downtown column on the heritage seam (k = HERITAGE_COLUMNS), a row from 1 to 5 by the dice
 *   among the free ones, its doorway west onto the seam street.
 * - 2, the timber loft: the lakefront row's lot west of the pier's axis, else the one east of it, facing the lake.
 * - 4, the glass villa, and 5, the estate: the first free lakefront lot of their lists (the villa near the row's middle,
 *   the estate at its east end), facing the lake.
 * - 6, the sky-mansion: the free headquarters lot with the tallest tower; 3, the penthouse: the free headquarters lot
 *   nearest the city's centre at least two lots (each way) from the sky-mansion. Each doorway faces a street the dice
 *   pick. With no such lot free, the home goes on the free downtown lot (k 5 to 14, m 1 to 12) nearest the centre.
 */
export function propertyLots(seed: number, buildings: readonly Building[]): HomeLot[] {
  const P = CITY.pitch, lake = CITY.blocks - 2, seam = HERITAGE_COLUMNS
  const rng = createRng((seed ^ 0x40e5f00d) >>> 0)
  const podiums = lotPodiums(buildings)
  const towers = hqTowers(buildings, podiums)
  const taken = new Set([...workplaceLots(seed), ...shopLots(seed)].map(key))
  const free = (k: number, m: number) => !taken.has(`${k},${m}`) && podiums.has(`${k},${m}`)
  const out: HomeLot[] = []
  const take = (home: number, k: number, m: number, side: Side) => {
    taken.add(`${k},${m}`)
    out.push({ home, k, m, side })
  }
  const first = (home: number, list: readonly (readonly [number, number, Side])[]) => {
    const f = list.find(([k, m]) => free(k, m))
    if (!f) throw new Error(`no free lot for ${PROPERTY_KINDS[home]}`)
    take(home, f[0], f[1], f[2])
  }
  const dist = (k: number, m: number) => Math.hypot((k + 0.5) * P - CITY_CENTER, (m + 0.5) * P - CITY_CENTER)
  const apart = (a: { k: number; m: number }, b: { k: number; m: number }) => Math.max(Math.abs(a.k - b.k), Math.abs(a.m - b.m))
  /** The free downtown lots well inside the grid, nearest the centre first: where a tower home goes when no tower is free. */
  const inner = () => {
    const list: { k: number; m: number }[] = []
    for (let k = seam + 1; k < CITY.blocks - 1; k++) for (let m = 1; m < lake - 1; m++) if (free(k, m)) list.push({ k, m })
    return list.sort((a, b) => dist(a.k, a.m) - dist(b.k, b.m) || a.k - b.k || a.m - b.m)
  }
  // 0: by the loop's platforms (k, m and the side facing the loop's street).
  first(0, [[8, 11, 0], [8, 12, 1], [11, 7, 2], [12, 7, 3], [7, 3, 0], [7, 4, 1], [4, 8, 3]])
  // 1: on the heritage seam, the row by the dice.
  const rows = [1, 2, 3, 4, 5].filter((m) => free(seam, m))
  if (rows.length === 0) throw new Error('no free lot for brownstone')
  take(1, seam, rows[Math.min(rows.length - 1, Math.floor(rng() * rows.length))], 3)
  // 2, 4 and 5: on the lakefront row, facing the lake.
  const pier = Math.floor(CITY_CENTER / P)
  first(2, [[pier - 1, lake, 0], [pier, lake, 0]])
  first(4, [11, 10, 12, 9, 13].map((k) => [k, lake, 0] as const))
  first(5, [15, 14, 13, 12, 11, 10, 9].map((k) => [k, lake, 0] as const))
  // 6 and 3: at the foot of the towers.
  const hq = () => towers.filter(({ k, m }) => free(k, m))
  const mansion = hq().sort((a, b) => b.top - a.top || a.k - b.k || a.m - b.m)[0] ?? inner()[0]
  if (!mansion) throw new Error('no free lot for skyMansion')
  take(6, mansion.k, mansion.m, Math.floor(rng() * 4) as Side)
  const far = (l: { k: number; m: number }) => apart(l, mansion) >= 2
  const fallback = inner()
  const penthouse = hq().filter(far).sort((a, b) => dist(a.k, a.m) - dist(b.k, b.m) || a.k - b.k || a.m - b.m)[0] ?? fallback.find(far) ?? fallback[0]
  if (!penthouse) throw new Error('no free lot for penthouse')
  take(3, penthouse.k, penthouse.m, Math.floor(rng() * 4) as Side)
  return out.sort((a, b) => a.home - b.home)
}

/** A local box to a city box between y0 and y1. */
function worldBox(room: { cx: number; cz: number; side: Side }, u0: number, v0: number, u1: number, v1: number, y0: number, y1: number): Box {
  const p = toWorld(room, u0, v0), q = toWorld(room, u1, v1)
  return [Math.min(p.x, q.x), y0, Math.min(p.z, q.z), Math.max(p.x, q.x), y1, Math.max(p.z, q.z)]
}

/** The fill block's finish by property index: masonry for the brownstone, timber deck for the timber loft, trim for the rest. */
const fillStyle = (home: number): number => (home === 1 ? STYLE.masonry : home === 2 ? STYLE.deck : STYLE.trim)

/**
 * The homes on the given lots, geometry and all: the city's (hollowProperties) or a region's (regionWorld.ts
 * hollowLots, from region/homes.ts). `podium` gives a lot's podium (its height and finish: the ceiling slab keeps the
 * podium's own finish, so the building above reads as it did). A lot's property index must be one of PROPERTY_KINDS'.
 * - The shell is the shop's exactly (storefronts.ts shopsAt): the back wall, the two side walls, the doorway's wall in
 *   two pieces round the opening, all glass from the floor to ROOM.height, and the ceiling slab over the whole lot.
 * - The fill block (in a home shallower than the grid) runs from the back wall's inner face to INSET behind the floor
 *   plan's back edge, between the side walls' inner faces, from the floor to the slab: it touches the glass and the
 *   slab and overlaps nothing.
 * - The planters stand in the doorway band, touching nothing (HOME.planter).
 */
export function homesAt(lots: readonly HomeLot[], podium: (k: number, m: number) => { top: number; style: number } = () => ({ top: ROOM.height + 1, style: STYLE.mixed })): Home[] {
  const h = CITY.lotHalf, inner = h - ROOM.wall
  const { u0, u1, v0, v1, height } = HOME.planter
  return lots.map(({ home, k, m, side }) => {
    if (!Number.isInteger(home) || home < 0 || home >= PROPERTY_KINDS.length) throw new RangeError(`no property ${home}`)
    const cx = (k + 0.5) * CITY.pitch, cz = (m + 0.5) * CITY.pitch
    const room = { cx, cz, side }
    const glass = STYLE.glass
    const p = podium(k, m)
    const top = Math.max(p.top, ROOM.height + 0.3)
    const shell: Building[] = [
      { box: worldBox(room, -h, -h, -inner, h, 0, ROOM.height), style: glass }, // the back wall
      { box: worldBox(room, -inner, -h, inner, -inner, 0, ROOM.height), style: glass }, // the two side walls
      { box: worldBox(room, -inner, inner, inner, h, 0, ROOM.height), style: glass },
      { box: worldBox(room, inner, -h, h, -ROOM.door, 0, ROOM.height), style: glass }, // the doorway wall, either side of the opening
      { box: worldBox(room, inner, ROOM.door, h, h, 0, ROOM.height), style: glass },
      { box: [cx - h, ROOM.height, cz - h, cx + h, top, cz + h], style: p.style }, // the ceiling slab: the podium above the home
    ]
    const back = backEdge(home)
    const fixtures: Building[] = []
    if (DEPTH[home] < GRID) fixtures.push({ box: worldBox(room, -inner, -inner, back - INSET, inner, 0, ROOM.height), style: fillStyle(home) })
    fixtures.push(
      { box: worldBox(room, u0, -v1, u1, -v0, 0, height), style: STYLE.concrete },
      { box: worldBox(room, u0, v0, u1, v1, 0, height), style: STYLE.concrete },
    )
    return { home, kind: PROPERTY_KINDS[home], k, m, cx, cz, side, door: toWorld(room, h, 0), depth: DEPTH[home], back, shell, fixtures, sky: null }
  })
}

/**
 * The sky floor's tuning, m: the clear glass's inner face (INSET outside the sky plan's edge at 7.78, as a hall keeps
 * behind its fill block), the band's thickness (its panes, mullions and corner posts), the room's height under the slab,
 * the slab's thickness, and how much tower is left over the slab at least.
 */
export const SKY_FLOOR = Object.freeze({ inner: GRID_HALF - SKY.r0 * CELL + INSET, band: 0.15, height: 4.2, slab: 0.3, above: 3 })

/**
 * A headquarters tower's box cut for its sky floor, on its lot's centre (cx, cz): its floor at F = 3.8 m × the whole
 * storeys that leave at least SKY_FLOOR.above + the room and slab over it, and in its place, in order, the tower below
 * (its finish), the 32 boxes of the band from F to F + 4.2 (on each face four clear panes and three rail mullions, then
 * the four rail corner posts), the trim slab and the tower above. Every piece lies inside the tower's footprint.
 */
function skyFloor(tower: Building, cx: number, cz: number): { y: number; boxes: Building[] } {
  const [x0, p, z0, x1, top, z1] = tower.box
  const { inner, band, height, slab, above } = SKY_FLOOR
  const y = 3.8 * Math.floor((top - height - slab - above) / 3.8), y1 = y + height
  const outer = inner + band, pane = (2 * inner - 3 * band) / 4
  const boxes: Building[] = [{ box: [x0, p, z0, x1, y, z1], style: tower.style }]
  for (let i = 0; i < 7; i++) {
    const a = -inner + Math.ceil(i / 2) * pane + Math.floor(i / 2) * band, b = i === 6 ? inner : a + (i & 1 ? band : pane)
    const style = i & 1 ? STYLE.rail : STYLE.clear
    for (const s of [-1, 1]) {
      const f0 = Math.min(s * inner, s * outer), f1 = Math.max(s * inner, s * outer)
      boxes.push({ box: [cx + a, y, cz + f0, cx + b, y1, cz + f1], style }, { box: [cx + f0, y, cz + a, cx + f1, y1, cz + b], style })
    }
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) boxes.push({ box: [cx + Math.min(sx * inner, sx * outer), y, cz + Math.min(sz * inner, sz * outer), cx + Math.max(sx * inner, sx * outer), y1, cz + Math.max(sz * inner, sz * outer)], style: STYLE.rail })
  boxes.push({ box: [x0, y1, z0, x1, y1 + slab, z1], style: STYLE.trim }, { box: [x0, y1 + slab, z0, x1, top, z1], style: tower.style })
  return { y, boxes }
}

/**
 * Hollows the home lots out of a generated city (city.ts cityPlan, after the workplaces and the shops): each lot's
 * podium becomes the home's shell, the ceiling slab up to the podium's top in the podium's finish, and its fixtures;
 * the tower over the Penthouse's and the Sky-Mansion's lots, when it is a headquarters tower, becomes its sky floor's
 * boxes (skyFloor), in the tower's place. Every other box (every other tower, every other lot) is untouched, and keeps
 * its order. Returns the homes, in PROPERTY_KINDS order.
 */
export function hollowProperties(seed: number, buildings: Building[]): Home[] {
  const lots = propertyLots(seed, buildings)
  const podiums = lotPodiums(buildings)
  const towers = hqTowers(buildings, podiums)
  const found = new Map<string, Podium>()
  for (const l of lots) {
    const p = podiums.get(key(l))
    if (!p) throw new Error(`lot ${key(l)} has no podium to hollow`)
    found.set(key(l), p)
  }
  const out = homesAt(lots, (k, m) => found.get(`${k},${m}`)!)
  const splices: [number, Building[]][] = out.map((home) => [found.get(key(home))!.at, [...home.shell, ...home.fixtures]])
  for (const home of out) {
    const t = skyRoom(home.home) >= 0 ? towers.find((x) => x.k === home.k && x.m === home.m) : undefined
    if (!t) continue
    home.sky = skyFloor(buildings[t.at], home.cx, home.cz)
    splices.push([t.at, home.sky.boxes])
  }
  // Splice from the highest index down, so the earlier indices stay valid.
  for (const [at, boxes] of splices.sort((p, q) => q[0] - p[0])) buildings.splice(at, 1, ...boxes)
  return out
}

let memo: { seed: number; homes: readonly Home[] } | null = null

/** The city's homes for a seed (city.ts cityPlan's), remembered for the last seed asked: the page asks every frame. */
export function cityHomes(seed: number): readonly Home[] {
  if (memo === null || memo.seed !== seed) memo = { seed, homes: Object.freeze(cityPlan(seed).homes) }
  return memo.homes
}

/** The property index of the home whose walls (x, z) stands inside (its doorway's band included), or −1. */
export function homeAt(list: readonly Home[], x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return -1
  for (const h of list) if (insideRoom(h, x, z)) return h.home
  return -1
}

// ---------------------------------------------------------------- the furniture's solids, as the worker checks them

/**
 * The bounds a solid box of a home's furniture is checked against (checkHomeBoxes), m. A piece's solid stands 1 cm
 * inside its cells (the page's floor plan, 02_Define_The_Rules/homeLayout.ts), so a sound one never comes near any of them.
 */
export const HOME_SOLID = Object.freeze({
  /** How far past the floor plan's edges a box may reach: its back edge, its two sides and its doorway edge (all at GRID_HALF but the back). */
  slack: 0.01,
  /** The thinnest a box may be, along x and along z. */
  thin: 0.05,
  /** The lowest a box may start: the floor, less the slack. */
  floor: -0.01,
  /** The highest a box may reach: 5 cm under the ceiling slab at ROOM.height. */
  ceiling: 4.15,
  /** The least a box may stand: anything lower is a step the avatar's controller could climb (it climbs 0.35 m). */
  height: 0.4,
} as const)

/**
 * A room's frame, all the worker needs to check a box against it: the room (a hall's property index, or a sky floor's
 * 7 or 8), the lot's centre, the doorway's street front, the floor plan's back edge (homeGrid.ts backEdge) and, for a
 * sky floor, its floor's height (absent: 0).
 */
export interface HomeFrame { home: number; cx: number; cz: number; side: Side; back: number; y?: number }

/**
 * The room frames of the homes on `list` (a region's lots, as SimInit.homes carries them, or the city's homes from
 * cityHomes), by property index: entry i is home i's frame, or null when this map has no home i. The same lot gives
 * the same frame as homesAt builds the home on. An index outside PROPERTY_KINDS, or one listed twice, is refused.
 */
export function homeFrames(list: readonly HomeLot[]): (HomeFrame | null)[] {
  const out: (HomeFrame | null)[] = PROPERTY_KINDS.map(() => null)
  for (const { home, k, m, side } of list) {
    if (!Number.isInteger(home) || home < 0 || home >= PROPERTY_KINDS.length) throw new RangeError(`no property ${home}`)
    if (out[home] !== null) throw new RangeError(`property ${home} listed twice`)
    out[home] = Object.freeze({ home, cx: (k + 0.5) * CITY.pitch, cz: (m + 0.5) * CITY.pitch, side, back: backEdge(home) })
  }
  return out
}

/**
 * The sky floors' room frames of the city's homes `list`, for rooms 7 and 8 (homeGrid.ts SKY_HOMES): each at its
 * floor's height, its back edge the sky plan's, or null where that home has no sky floor in `list` (a region: both).
 */
export function skyFrames(list: readonly Home[]): (HomeFrame | null)[] {
  return [7, 8].map((room) => {
    const h = list.find((x) => skyRoom(x.home) === room)
    return h?.sky ? Object.freeze({ home: room, cx: h.cx, cz: h.cz, side: h.side, back: backEdge(room), y: h.sky.y }) : null
  })
}

/**
 * One room's set of solid boxes as the page sends it (simCore.ts 'home'), checked: six city numbers per box (x0, y0,
 * z0, x1, y1, z1), at most HOME_PIECES boxes. Each box is turned into the room frame and must stand inside the room's
 * floor plan (homeGrid.ts planOf: u from the back edge to the plan's front, v within its columns, each with
 * HOME_SOLID.slack), on the floor, under the ceiling (both from the frame's floor height), at least HOME_SOLID.height
 * tall and HOME_SOLID.thin across, and must not overlap the block the room keeps clear (a hall's apron in front of the
 * doorway, a sky floor's arrival), so the way in is never blocked. Returns the boxes as city boxes; anything else
 * throws, with the reason. An empty list is sound: no solids.
 */
export function checkHomeBoxes(frame: HomeFrame, flat: unknown): Box[] {
  if (!Array.isArray(flat)) throw new Error('home: boxes must be a list of numbers')
  if (flat.length % 6 !== 0) throw new Error('home: boxes come in sixes (x0, y0, z0, x1, y1, z1)')
  if (flat.length / 6 > HOME_PIECES) throw new Error(`home: at most ${HOME_PIECES} boxes`)
  for (const n of flat) if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('home: every number of a box must be finite')
  const { slack, thin, floor, ceiling, height } = HOME_SOLID
  const base = frame.y ?? 0, plan = planOf(frame.home)!, keep = plan.keep
  const line = (n: number) => -GRID_HALF + n * CELL
  const u1 = line(plan.r1 + 1) + slack, v0 = line(plan.c0) - slack, v1 = line(plan.c1 + 1) + slack
  // The kept block's rectangle, shrunk by a micrometre: a box that only touches it (to within the rounding of the turn
  // into the room frame) keeps off it.
  const touch = 1e-6
  const apronU0 = line(keep.r0) + touch, apronU1 = line(keep.r1 + 1) - touch
  const apronV0 = line(keep.c0) + touch, apronV1 = line(keep.c1 + 1) - touch
  const kept = frame.home < DEPTH.length ? 'home: a box must keep off the apron in front of the doorway' : 'home: a box must keep off the arrival'
  const out: Box[] = []
  for (let i = 0; i < flat.length; i += 6) {
    const [x0, y0, z0, x1, y1, z1] = flat.slice(i, i + 6) as number[]
    if (!(x1 - x0 >= thin && z1 - z0 >= thin)) throw new Error(`home: a box must be at least ${thin} m across`)
    if (y0 < base + floor) throw new Error('home: a box must start on the floor')
    if (y1 > base + ceiling) throw new Error(`home: a box must stay under ${ceiling} m`)
    if (y1 - y0 < height) throw new Error(`home: a box must stand at least ${height} m tall`)
    const a = toLocal(frame, x0, z0), b = toLocal(frame, x1, z1)
    const bu0 = Math.min(a.u, b.u), bu1 = Math.max(a.u, b.u), bv0 = Math.min(a.v, b.v), bv1 = Math.max(a.v, b.v)
    if (bu0 < frame.back - slack || bu1 > u1 || bv0 < v0 || bv1 > v1) throw new Error("home: a box must stand inside the home's floor plan")
    if (bu1 > apronU0 && bu0 < apronU1 && bv1 > apronV0 && bv0 < apronV1) throw new Error(kept)
    out.push([x0, y0, z0, x1, y1, z1])
  }
  return out
}

// ---------------------------------------------------------------- the minimap

/**
 * The homes within `radius` metres of (x, z) on a minimap already in the engine's metres: the lot in gold for a home
 * the player owns (bit `home` of `ownedMask`) and in violet for one on sale, its floor inside the walls, and the
 * doorway cut through on its street front in the floor's colour, as drawShops draws a shop.
 */
export function drawHomes(ctx: RoomCanvas, list: readonly Home[], x: number, z: number, dark: boolean, ownedMask: number, radius = 150): void {
  const lotHalf = CITY.lotHalf
  for (const s of list) {
    if (Math.abs(s.cx - x) > radius || Math.abs(s.cz - z) > radius) continue
    const owned = ((ownedMask >>> s.home) & 1) === 1
    ctx.fillStyle = owned ? (dark ? '#b45309' : '#f59e0b') : (dark ? '#5b21b6' : '#8b5cf6')
    ctx.fillRect(s.cx - lotHalf, s.cz - lotHalf, lotHalf * 2, lotHalf * 2)
    const inner = lotHalf - ROOM.wall * 3
    ctx.fillStyle = owned ? (dark ? '#451a03' : '#fef3c7') : (dark ? '#2e1065' : '#ede9fe')
    ctx.fillRect(s.cx - inner, s.cz - inner, inner * 2, inner * 2)
    const d = doorDir(s.side)
    const w = ROOM.door * 2, depth = lotHalf - inner + 0.2
    const gx = s.cx + d.x * (lotHalf - depth / 2), gz = s.cz + d.z * (lotHalf - depth / 2)
    const [gw, gh] = d.x !== 0 ? [depth, w] : [w, depth]
    ctx.fillRect(gx - gw / 2, gz - gh / 2, gw, gh)
  }
}
