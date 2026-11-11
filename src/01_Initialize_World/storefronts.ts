// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the city's five storefronts: a tailor, a tattoo studio, a prosthetics atelier, a
 * watch and accessories shop and a design house (the furniture store and the property brokerage), each a ground-floor
 * shop on a lot of its own that the player walks into through its doorway. Everything here is pure and seeded: which
 * lots, which way each doorway faces, the shell, the fixtures (counters, mannequins, display cases, the scale models
 * of the properties) and the fitting spot where the player stands while the shop's catalogue is open.
 *
 * A shop is built the way an indoor workplace is (interiors.ts): the lot's podium (the solid box over the whole lot
 * from the ground) becomes floor-to-ceiling glass walls ROOM.wall thick with a doorway ROOM.door wide, a ceiling slab
 * that carries the podium above, and the fixtures, all axis-aligned boxes, so the renderer, the physics worker and the
 * flow field read the same shapes as they read every other box. The room frame is the workplaces' (u from the back
 * wall to the doorway, v across, interiors.ts toWorld), so their containment and glass tests (insideRoom, penetrates,
 * crossesGlass) serve a shop as they are.
 *
 * A shop is NOT a crowd room: the crowd shader's rooms are the workplaces alone, so its containment (crowd.wgsl
 * pushOut) still keeps every pedestrian out of a shop's lot square. Only the player walks in. The lots are picked
 * after the workplaces' (workplaceLots of the same seed) and never one of theirs, whatever that picker chooses.
 * What breaks if it is removed? The city has no shops: nowhere to walk in and buy what the wardrobe sells, and no
 * brokerage for the properties.
 */
import { createRng } from '../02_Define_The_Rules/degrees.ts'
// city.ts imports hollowShops back: a cycle, safe because neither module reads the other at load (every use is in a function).
import { CITY, CITY_CENTER, HERITAGE_COLUMNS, STYLE, type Box, type Building } from './city.ts'
import { ROOM, doorDir, insideRoom, toWorld, workplaceLots, type Side } from './interiors.ts'

/** The five shop kinds, in a fixed order (the index is the shop's stable id). */
export const SHOP_KINDS = ['tailor', 'inkStudio', 'prosthetics', 'horology', 'designHouse'] as const
export type ShopKind = (typeof SHOP_KINDS)[number]

/**
 * Each shop's name, the arcade it stands in in the city (a region's shop takes its street address instead: engine.ts)
 * and one line about it, as the card and the HUD say them. The names are invented and were searched for clashes with
 * real businesses in the same trade (docs/ip-audit.md, section 7): the
 * plan's tailor, watch shop and design house names were close to a clothing company's registered marks, registered
 * watch marks and an established design magazine, so all three were renamed; no real place is named (the plan's
 * waterfront arcade was a real neighbourhood's name).
 */
export const SHOP_INFO: Readonly<Record<ShopKind, { name: string; arcade: string; line: string }>> = Object.freeze({
  tailor: Object.freeze({ name: 'Verrin & Vale Tailors', arcade: 'Midtown Avenue', line: 'Bespoke suits, coats, trims and scarves, cut while you wait.' }),
  inkStudio: Object.freeze({ name: 'Aethelgard Ink Studio', arcade: 'Lakefront Arts Row', line: 'Fine-line, geometric and botanical designs, previewed before a needle moves.' }),
  prosthetics: Object.freeze({ name: 'Bio-Frame Prosthetics Atelier', arcade: 'Biomedical Plaza', line: 'Limbs, hearing tech and smart eyewear, fitted and finished to order.' }),
  horology: Object.freeze({ name: 'Escapement Row Horology', arcade: 'Financial District Arcade', line: 'Watches, briefcases, lapel pins and the small things that finish a look.' }),
  designHouse: Object.freeze({ name: 'Lintel & Lumen Design House', arcade: 'Waterline Galleria', line: 'Furniture, lighting and art, and the brokerage for every home you can own.' }),
})

/** The shop's tuning, frozen. */
export const SHOP = Object.freeze({
  /** The fitting spot, in the room frame: where the player stands while the catalogue is open (the mirror camera circles it). */
  fitting: Object.freeze({ u: 3, v: 0 }),
  /**
   * The radius about the fitting spot that no fixture comes within (grown by ROOM.pad), m: the mirror camera's orbit
   * (2.6 m out) stays clear of every fixture, and so does the walk from the doorway to the spot.
   */
  clear: 3.2,
  /** The mirror camera: its distance from the body, its height above the feet, the height it looks at, and its turn rate, rad/s. */
  orbit: Object.freeze({ radius: 2.6, height: 1.55, aim: 1.05, rate: 0.35 }),
} as const)

/** A mirror camera's orbit: its distance from the body, its height above the feet, the height it looks at, and its turn rate, rad/s. */
export interface Orbit {
  readonly radius: number
  readonly height: number
  readonly aim: number
  readonly rate: number
}

/**
 * A shop's own mirror camera, where SHOP.orbit does not suit its trade. The ink studio's comes in to 1.4 m, a little
 * lower and aimed a little higher, so a design on a hand, the neck or the nape fills about twice the pixels it would
 * at 2.6 m (a hand's square about 40 pixels across at 1080p instead of 21). Every orbit stays inside SHOP.clear, and
 * its eye stays farther from the head than the distance inside which the player's own figure is hidden
 * (storefronts.test.ts holds both).
 */
export const SHOP_ORBIT: Readonly<Partial<Record<ShopKind, Orbit>>> = Object.freeze({
  inkStudio: Object.freeze({ radius: 1.4, height: 1.45, aim: 1.1, rate: 0.35 }),
})

/** A shop's lot: its kind, the lot (between streets k and k + 1, m and m + 1) and its doorway's street front. */
export interface ShopLot { kind: ShopKind; k: number; m: number; side: Side }

export interface Shop {
  kind: ShopKind
  name: string
  /** Where it stands, as its card says it: the city's arcade for its kind, or a region's street address. */
  arcade: string
  k: number
  m: number
  /** The lot's centre, city metres. */
  cx: number
  cz: number
  side: Side
  /** The doorway's centre on the wall's outer face. */
  door: { x: number; z: number }
  /** The fixtures, city boxes. */
  furniture: Building[]
  /** The shell: the four glass walls (the doorway's split in two) and the ceiling slab up to the podium's top. */
  shell: Building[]
  /** Where the player stands while the catalogue is open, and the way they face there (atan2(x, z), towards the doorway). */
  fitting: { x: number; z: number; yaw: number }
}

/** A fixture in the room's frame: [u0, v0, u1, v1, y0, y1], and its finish. */
interface Piece { local: [number, number, number, number, number, number]; style: number }

/** A box in the room frame. */
const piece = (u0: number, v0: number, u1: number, v1: number, y0: number, y1: number, style: number): Piece => ({ local: [u0, v0, u1, v1, y0, y1], style })

/**
 * The fixtures every shop has: the sales counter across the back and the tall mirror on the back wall behind it.
 */
function counter(): Piece[] {
  const { deck, glass } = STYLE
  return [piece(-11.6, -4, -10.4, 4, 0, 1.05, deck), piece(-12.45, -3, -12.3, 3, 0.2, 2.8, glass)]
}

/** A mannequin at (u, v): its plinth and its figure. */
const mannequin = (u: number, v: number): Piece[] => [
  piece(u - 0.4, v - 0.4, u + 0.4, v + 0.4, 0, 0.25, STYLE.concrete),
  piece(u - 0.22, v - 0.18, u + 0.22, v + 0.18, 0.25, 1.85, STYLE.trim),
]

/**
 * The layouts, in the room's frame (u from the back wall, −12.5, to the doorway at +12.5; v across). Every one keeps
 * the walk from the doorway to the fitting spot (the axis, v = 0, from the doorway in to SHOP.fitting) and the circle of
 * SHOP.clear about that spot free of every fixture by more than a pedestrian's reach (storefronts.test.ts holds it).
 */
function layouts(): Record<ShopKind, Piece[]> {
  const { trim, concrete, masonry, deck, rail, mixed, glass } = STYLE
  return {
    // Bolts of cloth on both side walls, the cutting table, two rows of mannequins in the season's suits.
    tailor: [
      ...counter(),
      piece(-9, 11.6, 5, 12.4, 0, 2.4, rail),
      piece(-9, -12.4, 5, -11.6, 0, 2.4, rail),
      piece(-7.5, -1.2, -3.5, 1.2, 0, 0.9, deck),
      ...[-7, -3.5, 7, 10].flatMap((u) => [...mannequin(u, 6.5), ...mannequin(u, -6.5)]),
    ],
    // Two client chairs with their trolleys, the flash-art panels on both side walls, the waiting bench by the door.
    inkStudio: [
      ...counter(),
      piece(-6.4, 6.6, -4.2, 7.4, 0, 0.75, deck),
      piece(-3.8, 6.8, -3.3, 7.3, 0, 0.95, trim),
      piece(-6.4, -7.4, -4.2, -6.6, 0, 0.75, deck),
      piece(-3.8, -7.3, -3.3, -6.8, 0, 0.95, trim),
      piece(-8, 12.2, 8, 12.45, 0.8, 2.6, trim),
      piece(-8, -12.45, 8, -12.2, 0.8, 2.6, trim),
      piece(8, -9.4, 11, -8.6, 0, 0.45, concrete),
    ],
    // The gait walkway between its two rails, three plinths with a limb on each, the fitting bench by the door.
    prosthetics: [
      ...counter(),
      piece(-8, 7.2, 4, 7.4, 0, 1.0, rail),
      piece(-8, 9.0, 4, 9.2, 0, 1.0, rail),
      ...[-8, -4.5, -1].flatMap((u) => [piece(u - 0.5, -7.5, u + 0.5, -6.5, 0, 1.1, concrete), piece(u - 0.12, -7.12, u + 0.12, -6.88, 1.1, 1.9, trim)]),
      piece(6, -9.5, 9, -8.5, 0, 0.5, deck),
    ],
    // Display cases in two rows, wall cabinets down both sides.
    horology: [
      ...counter(),
      ...[-8, -4.5, -1, 7].flatMap((u) => [piece(u - 1.1, 5.6, u + 1.1, 6.3, 0, 1.0, deck), piece(u - 1.1, -6.3, u + 1.1, -5.6, 0, 1.0, deck)]),
      piece(-9, 11.9, 9, 12.45, 0, 2.2, rail),
      piece(-9, -12.45, 9, -11.9, 0, 2.2, rail),
    ],
    // The seven properties' scale models on their plinths (each model as tall as its tier is grand), the city table,
    // and the furniture samples: a sectional, two armchairs, a bookcase against the wall.
    designHouse: [
      ...counter(),
      ...[0.3, 0.45, 0.6, 0.9, 1.1, 1.35, 1.6].flatMap((h, i) => {
        const u = -9.5 + i * 2.5
        return [piece(u - 0.6, -7.6, u + 0.6, -6.4, 0, 0.9, deck), piece(u - 0.35, -7.35, u + 0.35, -6.65, 0.9, 0.9 + h, i < 4 ? mixed : glass)]
      }),
      piece(-8, -1.5, -4, 1.5, 0, 0.85, masonry),
      piece(-6, 6.5, -2, 7.5, 0, 0.8, concrete),
      piece(0, 6.6, 1, 7.6, 0, 0.8, concrete),
      piece(2, 6.6, 3, 7.6, 0, 0.8, concrete),
      piece(-9, 11.9, -1, 12.45, 0, 2.4, trim),
    ],
  }
}

// ---------------------------------------------------------------- the lots and the shops

/** Where each kind may stand: the lots (k, m) of its quarter, before the workplaces' and the other shops' are taken out. */
function quarter(kind: ShopKind): { k: number; m: number }[] {
  const out: { k: number; m: number }[] = []
  const add = (k0: number, k1: number, m0: number, m1: number) => {
    for (let k = k0; k < k1; k++) for (let m = m0; m < m1; m++) out.push({ k, m })
  }
  const k0 = HERITAGE_COLUMNS + 1, k1 = CITY.blocks - 1 // downtown, a column in from the heritage quarter and the ring
  const lake = CITY.blocks - 2 // the lakefront row
  switch (kind) {
    case 'tailor': add(k0, k1, 1, 6); break // midtown: the upper rows
    case 'prosthetics': add(k0, k1, 8, lake - 1); break // the lower rows, above the lakefront
    case 'horology': {
      // The Financial District: the lots round the centre (city.ts districtName's 2.5 pitches).
      const c = Math.floor(CITY_CENTER / CITY.pitch)
      add(c - 2, c + 2, c - 2, c + 2)
      break
    }
    case 'inkStudio': add(HERITAGE_COLUMNS, Math.floor(CITY.blocks / 2) + 1, lake, lake + 1); break // the lakefront row's west half
    case 'designHouse': add(Math.floor(CITY.blocks / 2) + 1, CITY.blocks, lake, lake + 1); break // its east half
  }
  return out
}

/**
 * The seed's shop lots: one per kind, each in its own quarter, never a workplace's lot (workplaceLots of the same seed)
 * and never another shop's. A downtown shop's doorway faces a street the dice pick; a lakefront shop's faces the lake
 * (south, +z). Lots and sides from the seed alone.
 */
export function shopLots(seed: number): ShopLot[] {
  const rng = createRng((seed ^ 0x5409f00d) >>> 0)
  const taken = new Set(workplaceLots(seed).map(({ k, m }) => `${k},${m}`))
  const lake = CITY.blocks - 2
  return SHOP_KINDS.map((kind) => {
    const free = quarter(kind).filter(({ k, m }) => !taken.has(`${k},${m}`))
    if (free.length === 0) throw new Error(`no free lot for the ${kind}`)
    const { k, m } = free[Math.floor(rng() * free.length)]
    taken.add(`${k},${m}`)
    const side = (m === lake ? 0 : Math.floor(rng() * 4)) as Side
    return { kind, k, m, side }
  })
}

/** A local box to a city box between y0 and y1. */
function worldBox(room: { cx: number; cz: number; side: Side }, u0: number, v0: number, u1: number, v1: number, y0: number, y1: number): Box {
  const p = toWorld(room, u0, v0), q = toWorld(room, u1, v1)
  return [Math.min(p.x, q.x), y0, Math.min(p.z, q.z), Math.max(p.x, q.x), y1, Math.max(p.z, q.z)]
}

/**
 * The shops on the given lots, geometry and all. `podium` gives a lot's podium (its height and finish: the ceiling
 * slab keeps the podium's own finish, so the building above reads as it did).
 */
export function shopsAt(lots: readonly ShopLot[], podium: (k: number, m: number) => { top: number; style: number } = () => ({ top: ROOM.height + 1, style: STYLE.mixed })): Shop[] {
  const L = layouts()
  const h = CITY.lotHalf, w = ROOM.wall, inner = h - w
  return lots.map(({ kind, k, m, side }) => {
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
      { box: [cx - h, ROOM.height, cz - h, cx + h, top, cz + h], style: p.style }, // the ceiling slab: the podium above the shop
    ]
    const furniture = L[kind].map(({ local: [u0, v0, u1, v1, y0, y1], style }) => ({ box: worldBox(room, u0, v0, u1, v1, y0, y1), style }))
    const f = toWorld(room, SHOP.fitting.u, SHOP.fitting.v)
    const d = doorDir(side)
    const { name, arcade } = SHOP_INFO[kind]
    return { kind, name, arcade, k, m, cx, cz, side, door: toWorld(room, h, 0), furniture, shell, fitting: { x: f.x, z: f.z, yaw: Math.atan2(d.x, d.z) } }
  })
}

/** The seed's five shops, geometry and all (the podium a stand-in: hollowShops reads the real one). */
export function shops(seed: number): Shop[] {
  return shopsAt(shopLots(seed))
}

/**
 * Hollows the shop lots out of a generated city (city.ts generateBuildings, after the workplaces): each lot's podium
 * becomes the shop's shell, the ceiling slab up to the podium's top in the podium's finish, and the fixtures. Every
 * other box is untouched. Returns the shops.
 */
export function hollowShops(seed: number, buildings: Building[]): Shop[] {
  const h = CITY.lotHalf
  const lots = shopLots(seed)
  const found = new Map<string, { at: number; top: number; style: number }>()
  for (const { k, m } of lots) {
    const cx = (k + 0.5) * CITY.pitch, cz = (m + 0.5) * CITY.pitch
    const at = buildings.findIndex(({ box: [x0, y0, z0, x1, , z1] }) => y0 === 0 && x0 === cx - h && x1 === cx + h && z0 === cz - h && z1 === cz + h)
    if (at < 0) throw new Error(`lot ${k},${m} has no podium to hollow`)
    found.set(`${k},${m}`, { at, top: buildings[at].box[4], style: buildings[at].style })
  }
  const out = shopsAt(lots, (k, m) => found.get(`${k},${m}`) ?? { top: ROOM.height + 1, style: STYLE.mixed })
  // Splice from the highest index down, so the earlier indices stay valid.
  const order = [...out].sort((p, q) => found.get(`${q.k},${q.m}`)!.at - found.get(`${p.k},${p.m}`)!.at)
  for (const s of order) buildings.splice(found.get(`${s.k},${s.m}`)!.at, 1, ...s.shell, ...s.furniture)
  return out
}

/** The index of the shop whose walls (x, z) stands inside (its doorway's band included), or −1. */
export function shopAt(list: readonly Shop[], x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return -1
  for (let i = 0; i < list.length; i++) if (insideRoom(list[i], x, z)) return i
  return -1
}

/**
 * The mirror camera's eye for a body standing at (x, feetY, z), `angle` radians round it (0: on the side the body
 * faces when it stands at the fitting spot, looking back at it), and the point it looks at, on `orbit` (SHOP.orbit,
 * or the shop's own from SHOP_ORBIT).
 */
export function orbitEye(x: number, feetY: number, z: number, angle: number, orbit: Orbit = SHOP.orbit): { eye: { x: number; y: number; z: number }; at: { x: number; y: number; z: number } } {
  const { radius, height, aim } = orbit
  return {
    eye: { x: x + Math.sin(angle) * radius, y: feetY + height, z: z + Math.cos(angle) * radius },
    at: { x, y: feetY + aim, z },
  }
}

// ---------------------------------------------------------------- the minimap

/** What drawShops needs of a canvas (a CanvasRenderingContext2D is one). */
export interface ShopCanvas {
  fillStyle: string | object
  fillRect(x: number, y: number, w: number, h: number): void
}

/**
 * The shops within `radius` metres of (x, z) on a minimap already in the engine's metres: the lot in the shops' teal,
 * its floor inside the walls, and the doorway cut through on its street front, as drawRooms draws a workplace.
 */
export function drawShops(ctx: ShopCanvas, list: readonly Shop[], x: number, z: number, dark: boolean, radius = 150): void {
  const lotHalf = CITY.lotHalf
  for (const s of list) {
    if (Math.abs(s.cx - x) > radius || Math.abs(s.cz - z) > radius) continue
    ctx.fillStyle = dark ? '#0f766e' : '#14b8a6'
    ctx.fillRect(s.cx - lotHalf, s.cz - lotHalf, lotHalf * 2, lotHalf * 2)
    const inner = lotHalf - ROOM.wall * 3
    ctx.fillStyle = dark ? '#042f2e' : '#ccfbf1'
    ctx.fillRect(s.cx - inner, s.cz - inner, inner * 2, inner * 2)
    const d = doorDir(s.side)
    const w = ROOM.door * 2, depth = lotHalf - inner + 0.2
    const gx = s.cx + d.x * (lotHalf - depth / 2), gz = s.cz + d.z * (lotHalf - depth / 2)
    const [gw, gh] = d.x !== 0 ? [depth, w] : [w, depth]
    ctx.fillRect(gx - gw / 2, gz - gh / 2, gw, gh)
  }
}
