// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the city's indoor workplaces: six downtown lots whose ground floor is hollowed into
 * a room people can walk into, one per workplace kind (a robotics lab, a boardroom, a logistics warehouse, a triage
 * clinic, legal chambers and a telemetry command room), each with its furniture and the workstations where the
 * pedestrians the crowd assigns to it stand and work. Everything here is pure and seeded: which lots, which way the
 * doorway faces, the furniture boxes (axis-aligned, like every box of the city, so Rapier, the flow field and the
 * crowd read the same shapes), the stations and the route from the sidewalk to each one.
 *
 * Three readers share these numbers, and this file keeps them one:
 * - city.ts (`hollowWorkplaces`) swaps a chosen lot's solid podium for the room's shell: floor-to-ceiling glass walls
 *   ROOM.wall thick with a doorway ROOM.door wide, a ceiling slab that carries the podium above, and the furniture;
 *   the physics worker and the renderer take those boxes as they take any other;
 * - the flow field (06_Make_Decisions/flowField.ts) rasterises the same boxes, so a summoned person routes through the
 *   doorway to an operator standing inside;
 * - the crowd shader (03_Spawn_Agents/crowd.wgsl) reads the rooms from its uniform (`packRooms`): which lots are rooms,
 *   where the doorway is, the furniture to slide round and the stations to commute to. `containInRoom` is the CPU
 *   mirror of its containment (interiors.test.ts walks it), `routeIn`/`targetCorner` the mirror of its route.
 * The local frame of a room: u runs from the back wall (−) to the doorway (+), v across it; the doorway is centred at
 * v = 0 on the wall at u = +lotHalf, and `doorDir(side)` says which of the lot's four street fronts that is. Layouts
 * are written once in that frame and rotated into the city, so a room's furniture never changes with its door.
 * What breaks if it is removed? Every lot is solid to the ground: nobody has anywhere indoors to go, the crowd has
 * no workday, and the operator cannot walk into a building.
 */
import { createRng } from '../02_Define_The_Rules/degrees.ts'
// city.ts imports hollowWorkplaces back: a cycle, safe because neither module reads the other at load (every use is in a function).
import { CITY, HERITAGE_COLUMNS, STYLE, type Box, type Building } from './city.ts'

/** The room's tuning, frozen: policy about what a workplace is. */
export const ROOM = Object.freeze({
  /** Wall thickness, m: the glass facade of the ground floor. */
  wall: 0.5,
  /** Floor to ceiling, m: the room's height; the podium continues above as the ceiling slab. */
  height: 4.2,
  /** Half the doorway's width, m (a 4 m opening, centred on its wall). */
  door: 2.0,
  /** Rooms the crowd shader's uniform carries: one per workplace kind. */
  slots: 6,
  /** Furniture boxes per room the uniform carries (a layout has at most this many). */
  furniture: 16,
  /** Stations per room (a layout has exactly this many). */
  stations: 8,
  /** The hub, m along u from the lot centre: the point just inside the doorway every route passes through. */
  hub: 11,
  /** A pedestrian's reach, m: the crowd's containment pad (crowd.wgsl pushOut's). */
  pad: 0.35,
} as const)

/** The crowd's workday, frozen. */
export const WORK = Object.freeze({
  /**
   * Workers per station, about: the share of the crowd with a workplace is set so that the 48 stations have this many
   * people each over a day (on shift WORK.shift / WORK.cycle of the time, so about one at a station at once). A
   * bigger crowd has a smaller share, never a crowded room.
   */
  perStation: 1.6,
  /** The largest share there is: one pedestrian in this many, whatever the crowd's size. */
  minOneIn: 8,
  /** Coprime with the 48 stations: the w-th worker is dealt station w × deal mod 48, every station once before any twice. */
  deal: 29,
  /** A worker's day, s: the shift, then the rest of the cycle off duty on the streets. */
  cycle: 480,
  shift: 300,
  /** Hash salt of the worker lottery, its station and its shift's start (crowd.wgsl WORK_SALT). */
  salt: 0x7f4a7c15,
} as const)

/** The six workplace kinds, in station-slot order. */
export const WORKPLACE_KINDS = ['roboticsLab', 'boardroom', 'warehouse', 'clinic', 'legalChambers', 'telemetryCommand'] as const
export type WorkplaceKind = (typeof WORKPLACE_KINDS)[number]

/** What a person does at a station: the crowd draws the same working pose for each (ACTIVITY.working); the word is the HUD's. */
export type Task = 'typing' | 'inspecting' | 'collaborating'

/** A doorway's street front: 0 faces +z (south), 1 −z (north), 2 +x (east), 3 −x (west). */
export type Side = 0 | 1 | 2 | 3

/** A furniture box in the room's frame: [u0, v0, u1, v1, y0, y1], and its finish. */
interface Piece { local: [number, number, number, number, number, number]; style: number }
/** A station in the room's frame: where to stand, which way to face (unit, local), what to do there. */
interface LocalStation { u: number; v: number; fu: number; fv: number; task: Task }
interface Layout { name: string; furniture: Piece[]; stations: LocalStation[] }

export interface Station {
  /** Where to stand, city metres. */
  x: number
  z: number
  /** The way to face, radians (atan2(x, z), the crowd's heading). */
  yaw: number
  /** The same point in the room's frame (the shader carries this and rotates it). */
  u: number
  v: number
  task: Task
}

export interface Workplace {
  kind: WorkplaceKind
  name: string
  /** The lot: between streets k and k + 1, m and m + 1. */
  k: number
  m: number
  /** The lot's centre, city metres. */
  cx: number
  cz: number
  side: Side
  /** The doorway's centre on the wall's outer face. */
  door: { x: number; z: number }
  /** The furniture, city boxes. */
  furniture: Building[]
  /** The shell: the four glass walls (the doorway's split in two) and the ceiling slab up to the podium's top. */
  shell: Building[]
  stations: Station[]
}

/** The u axis's direction in the city for a doorway side, and the v axis's (d rotated a quarter turn clockwise). */
export function doorDir(side: Side): { x: number; z: number } {
  return side === 0 ? { x: 0, z: 1 } : side === 1 ? { x: 0, z: -1 } : side === 2 ? { x: 1, z: 0 } : { x: -1, z: 0 }
}
export function acrossDir(side: Side): { x: number; z: number } {
  const d = doorDir(side)
  return { x: d.z, z: -d.x }
}

/** A room-frame point (u, v) in the city. */
export function toWorld(room: { cx: number; cz: number; side: Side }, u: number, v: number): { x: number; z: number } {
  const d = doorDir(room.side), a = acrossDir(room.side)
  return { x: room.cx + u * d.x + v * a.x, z: room.cz + u * d.z + v * a.z }
}

/** A city point in the room's frame. */
export function toLocal(room: { cx: number; cz: number; side: Side }, x: number, z: number): { u: number; v: number } {
  const d = doorDir(room.side), a = acrossDir(room.side)
  const dx = x - room.cx, dz = z - room.cz
  return { u: dx * d.x + dz * d.z, v: dx * a.x + dz * a.z }
}

// ---------------------------------------------------------------- the six layouts

/** A row of four pieces along u (the four bays at u = −9, −5, −1, 3), each `along` long, between v0 and v1. */
const bays = (v0: number, v1: number, y0: number, y1: number, style: number, along = 3): Piece[] =>
  [-9, -5, -1, 3].map((u) => ({ local: [u - along / 2, v0, u + along / 2, v1, y0, y1], style }))
/** Four stations along a row at v, facing fv (towards the furniture beyond). */
const row = (v: number, fv: 1 | -1, task: Task): LocalStation[] => [-9, -5, -1, 3].map((u) => ({ u, v, fu: 0, fv, task }))

/**
 * The layouts, in the room's frame. Every one keeps the hub's cross aisle (u = ROOM.hub, |v| ≤ 5) and the station rows
 * (v = ±4.6, or ±3 round the boardroom table) clear of furniture by more than a pedestrian's reach, so the route
 * doorway → hub → row → station is a straight walk on each leg (interiors.test.ts holds that for every station).
 */
function layouts(): Record<WorkplaceKind, Layout> {
  const { trim, concrete, masonry, deck, rail } = STYLE
  return {
    roboticsLab: {
      name: 'Sim-to-Real Robotics Lab',
      furniture: [
        // Four robot arm cells: a pedestal and the arm's column rising from it.
        ...bays(-8.2, -5.6, 0, 1.1, concrete, 2.4),
        ...[-9, -5, -1, 3].map((u): Piece => ({ local: [u - 0.3, -7.2, u + 0.3, -6.6, 1.1, 2.4], style: trim })),
        // Sensor calibration tables, a server rack along the wall behind them, telemetry terminals on the back wall.
        ...bays(5.6, 6.6, 0, 0.9, deck),
        { local: [-11, 9.6, 5, 10.4, 0, 2.2], style: rail },
        { local: [-12.3, -4, -11.7, 4, 0, 2.0], style: trim },
      ],
      stations: [...row(-4.6, -1, 'inspecting'), ...row(4.6, 1, 'typing')],
    },
    boardroom: {
      name: 'Executive Boardroom',
      furniture: [
        // The conference table, and the holographic city plinth by the door.
        { local: [-10, -1.8, -2, 1.8, 0, 0.75], style: deck },
        { local: [2, -0.8, 3.6, 0.8, 0, 1.0], style: trim },
      ],
      stations: [
        ...[-9, -6.5, -4, -1.5].map((u): LocalStation => ({ u, v: -3, fu: 0, fv: 1, task: 'collaborating' })),
        ...[-9, -6.5, -4, -1.5].map((u): LocalStation => ({ u, v: 3, fu: 0, fv: -1, task: 'collaborating' })),
      ],
    },
    warehouse: {
      name: 'Automated Logistics Warehouse',
      furniture: [
        // High-bay pallet racks, a conveyor sorting lane, AGV charging docks behind it.
        ...bays(-10.4, -5.6, 0, 3.8, masonry, 2.8),
        { local: [-10, 5.6, 4, 6.4, 0, 0.8], style: trim },
        ...[-9, -5, -1, 3].map((u): Piece => ({ local: [u - 0.6, 9.4, u + 0.6, 10.6, 0, 0.3], style: concrete })),
      ],
      stations: [...row(-4.6, -1, 'inspecting'), ...row(4.6, 1, 'typing')],
    },
    clinic: {
      name: 'Medical Triage Clinic',
      furniture: [
        // Two diagnostic imaging bays, four triage desks, the pharmacy dispensers along the back wall.
        { local: [-9.5, -9.4, -6.5, -5.6, 0, 2.2], style: concrete },
        { local: [-3.5, -9.4, -0.5, -5.6, 0, 2.2], style: concrete },
        ...bays(5.6, 6.6, 0, 0.9, deck),
        { local: [-12.3, -3, -11.7, 3, 0, 2.2], style: trim },
      ],
      stations: [...row(-4.6, -1, 'inspecting'), ...row(4.6, 1, 'typing')],
    },
    legalChambers: {
      name: 'Civic Legal Chambers',
      furniture: [
        // Contract verification terminals, the registry vault against the back wall, arbitration desks.
        ...bays(-7.4, -5.6, 0, 1.1, trim, 2.6),
        { local: [-12.3, -4, -9.5, 4, 0, 2.6], style: masonry },
        ...bays(5.6, 6.6, 0, 0.9, deck),
      ],
      stations: [...row(-4.6, -1, 'typing'), ...row(4.6, 1, 'collaborating')],
    },
    telemetryCommand: {
      name: 'Telemetry Command',
      furniture: [
        // Multi-monitor desks (a desk and its monitor bank), orchestration consoles, the wall display at the back.
        ...bays(-7.0, -5.6, 0, 0.9, deck),
        ...bays(-6.6, -6.2, 0.9, 1.6, trim, 2.8),
        ...bays(5.6, 6.8, 0, 1.4, rail, 2.4),
        { local: [-12.3, -8, -11.7, 8, 0.6, 3.2], style: trim },
      ],
      stations: [...row(-4.6, -1, 'typing'), ...row(4.6, 1, 'typing')],
    },
  }
}

// ---------------------------------------------------------------- the lots and the rooms

/**
 * The seed's workplace lots: one per kind, each in its own sixth of the downtown (three columns of lots by two rows),
 * never the ring, the heritage quarter, the lakefront rows or the park, so every room has four streets and a doorway
 * side the dice may pick freely. Lots and sides from the seed alone.
 */
export function workplaceLots(seed: number): { kind: WorkplaceKind; k: number; m: number; side: Side }[] {
  const rng = createRng(seed ^ 0x1a7e)
  const k0 = HERITAGE_COLUMNS, k1 = CITY.blocks // downtown columns [k0, k1)
  const m0 = 0, m1 = CITY.blocks - 2 // downtown rows [m0, m1): the lakefront row and the park are below
  const cols = 3, rows = 2
  return WORKPLACE_KINDS.map((kind, i) => {
    const c = i % cols, r = Math.floor(i / cols)
    const ka = k0 + Math.floor(((k1 - k0) * c) / cols), kb = k0 + Math.floor(((k1 - k0) * (c + 1)) / cols)
    const ma = m0 + Math.floor(((m1 - m0) * r) / rows), mb = m0 + Math.floor(((m1 - m0) * (r + 1)) / rows)
    const k = ka + Math.floor(rng() * (kb - ka)), m = ma + Math.floor(rng() * (mb - ma))
    return { kind, k, m, side: Math.floor(rng() * 4) as Side }
  })
}

/** A local box to a city box between y0 and y1. */
function worldBox(room: { cx: number; cz: number; side: Side }, u0: number, v0: number, u1: number, v1: number, y0: number, y1: number): Box {
  const p = toWorld(room, u0, v0), q = toWorld(room, u1, v1)
  return [Math.min(p.x, q.x), y0, Math.min(p.z, q.z), Math.max(p.x, q.x), y1, Math.max(p.z, q.z)]
}

/** The seed's six workplaces, geometry and all. `podium` gives a lot's podium height (the ceiling slab's top). */
export function workplaces(seed: number, podium: (k: number, m: number) => number = () => ROOM.height + 1): Workplace[] {
  const L = layouts()
  const h = CITY.lotHalf, w = ROOM.wall, inner = h - w
  return workplaceLots(seed).map(({ kind, k, m, side }) => {
    const cx = (k + 0.5) * CITY.pitch, cz = (m + 0.5) * CITY.pitch
    const room = { cx, cz, side }
    const layout = L[kind]
    const glass = STYLE.glass
    const top = Math.max(podium(k, m), ROOM.height + 0.3)
    const shell: Building[] = [
      { box: worldBox(room, -h, -h, -inner, h, 0, ROOM.height), style: glass }, // the back wall
      { box: worldBox(room, -inner, -h, inner, -inner, 0, ROOM.height), style: glass }, // the two side walls
      { box: worldBox(room, -inner, inner, inner, h, 0, ROOM.height), style: glass },
      { box: worldBox(room, inner, -h, h, -ROOM.door, 0, ROOM.height), style: glass }, // the doorway wall, either side of the opening
      { box: worldBox(room, inner, ROOM.door, h, h, 0, ROOM.height), style: glass },
      { box: [cx - h, ROOM.height, cz - h, cx + h, top, cz + h], style: STYLE.mixed }, // the ceiling slab: the podium above the room
    ]
    const furniture = layout.furniture.map(({ local: [u0, v0, u1, v1, y0, y1], style }) => ({ box: worldBox(room, u0, v0, u1, v1, y0, y1), style }))
    const d = doorDir(side), a = acrossDir(side)
    const stations = layout.stations.map(({ u, v, fu, fv, task }): Station => {
      const p = toWorld(room, u, v)
      return { x: p.x, z: p.z, yaw: Math.atan2(fu * d.x + fv * a.x, fu * d.z + fv * a.z), u, v, task }
    })
    const door = toWorld(room, h, 0)
    return { kind, name: layout.name, k, m, cx, cz, side, door, furniture, shell, stations }
  })
}

/**
 * Hollows the workplace lots out of a generated city (city.ts generateBuildings): each lot's podium (the solid box over
 * the whole lot from the ground) becomes the room's shell, the ceiling slab up to the podium's top, and the furniture.
 * Every other box (the towers above, every other lot) is untouched. Returns the podium heights it found, by lot.
 */
export function hollowWorkplaces(seed: number, buildings: Building[]): Workplace[] {
  const h = CITY.lotHalf
  const lots = workplaceLots(seed)
  const podiums = new Map<string, number>()
  const podiumIndex = new Map<string, number>()
  for (const { k, m } of lots) {
    const cx = (k + 0.5) * CITY.pitch, cz = (m + 0.5) * CITY.pitch
    const at = buildings.findIndex(({ box: [x0, y0, z0, x1, , z1] }) => y0 === 0 && x0 === cx - h && x1 === cx + h && z0 === cz - h && z1 === cz + h)
    if (at < 0) throw new Error(`lot ${k},${m} has no podium to hollow`)
    podiums.set(`${k},${m}`, buildings[at].box[4])
    podiumIndex.set(`${k},${m}`, at)
  }
  const rooms = workplaces(seed, (k, m) => podiums.get(`${k},${m}`) ?? ROOM.height + 1)
  // Splice from the highest index down, so the earlier indices stay valid.
  const order = [...rooms].sort((p, q) => podiumIndex.get(`${q.k},${q.m}`)! - podiumIndex.get(`${p.k},${p.m}`)!)
  for (const room of order) buildings.splice(podiumIndex.get(`${room.k},${room.m}`)!, 1, ...room.shell, ...room.furniture)
  return rooms
}

// ---------------------------------------------------------------- the route (the shader's, mirrored)

/**
 * The sidewalk corner a commuter heads for on the corner graph: the corner of the doorway's street on the room's own
 * block, at the end the route along the lane starts from (crowd.wgsl targetCorner). Its lane coordinate is the door
 * front's, so the last stretch is a straight walk along the sidewalk.
 */
export function targetCorner(room: { k: number; m: number; side: Side }, lane = CITY.lane): { k: number; m: number; sx: 1 | -1; sz: 1 | -1; x: number; z: number } {
  const { k, m, side } = room
  const c = side === 0 ? { k, m: m + 1, sx: 1 as const, sz: -1 as const }
    : side === 1 ? { k, m, sx: 1 as const, sz: 1 as const }
    : side === 2 ? { k: k + 1, m, sx: -1 as const, sz: 1 as const }
    : { k, m, sx: 1 as const, sz: 1 as const }
  return { ...c, x: c.k * CITY.pitch + c.sx * lane, z: c.m * CITY.pitch + c.sz * lane }
}

/** The door front: the point on the sidewalk lane outside the doorway, where the route leaves the street. */
export function doorFront(room: { cx: number; cz: number; side: Side }, lane = CITY.lane): { x: number; z: number } {
  return toWorld(room, CITY.pitch / 2 - lane, 0)
}

/**
 * The legs of the walk from the door front to station `s`: through the doorway to the hub, across to the station's
 * row, along the row to the station. Leaving is the same walk backwards.
 */
export function routeIn(room: Workplace, s: number): { x: number; z: number }[] {
  const st = room.stations[s]
  return [doorFront(room), toWorld(room, ROOM.hub, 0), toWorld(room, ROOM.hub, st.v), { x: st.x, z: st.z }]
}

// ---------------------------------------------------------------- the containment (the shader's, mirrored)

/**
 * Where a pedestrian stepping from `from` to `to` ends up, in a room's lot (crowd.wgsl containRoom): the glass walls
 * are a band between the room (|u|, |v| < lotHalf − wall) and the street (beyond lotHalf), each grown by `pad`; a
 * step that lands in the band is put back on the side it came from (the projection onto the nearest free point of
 * that side, so the rest of the step slides along the wall), except through the doorway, where the band is open for
 * |v| < door − pad. Inside, every furniture box grown by `pad` pushes a step out along its least-penetrated axis.
 * A step from outside a room's lot never ends inside its walls, and one from inside never ends in them or outside.
 */
export function containInRoom(room: { cx: number; cz: number; side: Side; furniture: readonly { box: Box }[] }, from: { x: number; z: number }, to: { x: number; z: number }, pad: number = ROOM.pad): { x: number; z: number } {
  const h = CITY.lotHalf, w = ROOM.wall
  const limOut = h + pad, limIn = h - w - pad
  let { u, v } = toLocal(room, to.x, to.z)
  const m = Math.max(Math.abs(u), Math.abs(v))
  const inDoor = u > 0 && Math.abs(v) < ROOM.door - pad
  if (m > limIn && m < limOut && !inDoor) {
    const f = toLocal(room, from.x, from.z)
    const fromInside = Math.max(Math.abs(f.u), Math.abs(f.v)) < h - w / 2
    if (fromInside) {
      u = Math.max(-limIn, Math.min(limIn, u))
      v = Math.max(-limIn, Math.min(limIn, v))
    } else if (limOut - Math.abs(u) < limOut - Math.abs(v)) {
      u = u >= 0 ? limOut : -limOut
    } else {
      v = v >= 0 ? limOut : -limOut
    }
  }
  let p = toWorld(room, u, v)
  for (const { box: [x0, , z0, x1, , z1] } of room.furniture) {
    const lx = x0 - pad, hx = x1 + pad, lz = z0 - pad, hz = z1 + pad
    if (p.x <= lx || p.x >= hx || p.z <= lz || p.z >= hz) continue
    const dx = Math.min(p.x - lx, hx - p.x), dz = Math.min(p.z - lz, hz - p.z)
    if (dx < dz) p = { x: p.x - lx < hx - p.x ? lx : hx, z: p.z }
    else p = { x: p.x, z: p.z - lz < hz - p.z ? lz : hz }
  }
  return p
}

/** True when (x, z) is inside the walls of a room, the doorway's band included (checkCrowd's exemption). */
export function insideRoom(room: { cx: number; cz: number; side: Side }, x: number, z: number): boolean {
  const { u, v } = toLocal(room, x, z)
  const h = CITY.lotHalf
  return (Math.max(Math.abs(u), Math.abs(v)) < h - ROOM.wall) || (u > 0 && u < h + ROOM.pad && Math.abs(v) < ROOM.door)
}

/** True when (x, z) lies in a wall (the band, outside the doorway) or in a furniture box, grown by `pad`: a penetration. */
export function penetrates(room: { cx: number; cz: number; side: Side; furniture: readonly { box: Box }[] }, x: number, z: number, pad: number = ROOM.pad, eps = 1e-6): boolean {
  const { u, v } = toLocal(room, x, z)
  const h = CITY.lotHalf
  const m = Math.max(Math.abs(u), Math.abs(v))
  if (m > h - ROOM.wall - pad + eps && m < h + pad - eps && !(u > 0 && Math.abs(v) < ROOM.door - pad + eps)) return true
  for (const { box: [x0, , z0, x1, , z1] } of room.furniture) {
    if (x > x0 - pad + eps && x < x1 + pad - eps && z > z0 - pad + eps && z < z1 + pad - eps) return true
  }
  return false
}

// ---------------------------------------------------------------- the uniform (crowd.wgsl Params.rooms)

/** Floats per room in the uniform: a, b, the furniture boxes, the stations (vec4f each). */
export const ROOM_FLOATS = 4 + 4 + ROOM.furniture * 4 + ROOM.stations * 4
/** Floats of the whole rooms block. */
export const ROOMS_FLOATS = ROOM.slots * ROOM_FLOATS

/**
 * The rooms as the shader reads them (struct Room: a = (cx, cz, side, present), b = (hub u, furniture count, -, -),
 * furniture[] = (x0, z0, x1, z1), stations[] = (u, v, yaw, present)). An empty block (no rooms: a region) is all zero.
 */
export function packRooms(rooms: readonly Workplace[], out = new Float32Array(ROOMS_FLOATS)): Float32Array {
  if (rooms.length > ROOM.slots) throw new RangeError(`at most ${ROOM.slots} rooms`)
  out.fill(0)
  rooms.forEach((room, r) => {
    if (room.furniture.length > ROOM.furniture || room.stations.length > ROOM.stations) throw new RangeError(`${room.kind}: too much furniture or too many stations`)
    const o = r * ROOM_FLOATS
    out[o] = room.cx; out[o + 1] = room.cz; out[o + 2] = room.side; out[o + 3] = 1
    out[o + 4] = ROOM.hub; out[o + 5] = room.furniture.length
    room.furniture.forEach(({ box }, i) => {
      const f = o + 8 + i * 4
      out[f] = box[0]; out[f + 1] = box[2]; out[f + 2] = box[3]; out[f + 3] = box[5]
    })
    room.stations.forEach((s, i) => {
      const f = o + 8 + ROOM.furniture * 4 + i * 4
      out[f] = s.u; out[f + 1] = s.v; out[f + 2] = s.yaw; out[f + 3] = 1
    })
  })
  return out
}

// ---------------------------------------------------------------- the workday (the shader's dice, mirrored)

/** crowd.wgsl pcg / hash2 / rand, bit for bit, for the worker lottery. */
function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0
  return ((w >>> 22) ^ w) >>> 0
}
const hash2 = (a: number, b: number): number => pcg((a ^ pcg((b + 0x9e3779b9) >>> 0)) >>> 0)
const rand = (a: number, b: number): number => (hash2(a, b) >>> 8) / 16777216

/**
 * One pedestrian in this many has a workplace in a crowd of `agentCount` (crowd.wgsl WORK_ONE_IN, baked per crowd).
 * Always odd: the workers are every WORK_ONE_IN-th index, and an odd stride runs through the crowd's four bodies
 * (crowd.wgsl cull: i % VARIANTS) instead of dressing every worker alike.
 */
export function workOneIn(agentCount: number): number {
  const n = Math.floor(agentCount / (ROOM.slots * ROOM.stations * WORK.perStation))
  return Math.max(WORK.minOneIn, Number.isFinite(n) ? n : WORK.minOneIn) | 1
}

/**
 * Agent i's station slot (room × ROOM.stations + station) in a crowd of `agentCount`, or −1 for someone with no
 * workplace (crowd.wgsl workerSlot; the shader also says −1 for a slot whose room this world does not have). The
 * workers are the indices one short of a multiple of WORK_ONE_IN (never 0, the player's own body), and the w-th of
 * them is dealt station w × WORK.deal mod 48: every station once before any twice, the rooms in turn.
 */
export function workerSlot(i: number, agentCount: number): number {
  const oneIn = workOneIn(agentCount)
  if ((i + 1) % oneIn !== 0) return -1
  const w = (i + 1) / oneIn - 1
  return (w * WORK.deal) % (ROOM.slots * ROOM.stations)
}

/** Whether worker i is on shift at realm time t (crowd.wgsl onDuty): each has their own start within the cycle. */
export function onDuty(i: number, t: number): boolean {
  const s = t + rand(i, WORK.salt + 2) * WORK.cycle
  return s - WORK.cycle * Math.floor(s / WORK.cycle) < WORK.shift
}
