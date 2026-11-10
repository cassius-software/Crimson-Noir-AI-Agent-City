// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the city's indoor workplaces: sixteen downtown lots whose ground floor is hollowed
 * into a room people can walk into, one per workplace kind (WORKPLACE_KINDS: a robotics lab, a warehouse, a server
 * vault, metro operations, a control tower, a kitchen, a micro-fab, a twin studio, a fleet bay, a greenhouse, an
 * acoustics chamber, a response centre, a clearing floor, a gait lab, a microgrid room and the console deck), each with
 * its furniture and the eight workstations where the pedestrians the crowd assigns to it stand and work. Everything
 * here is pure and seeded: which lots, which way the doorway faces, the furniture boxes (axis-aligned, like every box
 * of the city, so Rapier, the flow field and the crowd read the same shapes), the stations and the route from the
 * sidewalk to each one. The kind's index is its slot: the crowd's station slots, the uniform's rooms and the flat
 * tables another thread dispatches by (workplaceTable, stationTable) all count rooms in WORKPLACE_KINDS order.
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
  /**
   * Rooms the crowd shader's uniform carries: one per workplace kind (WORKPLACE_KINDS.length). Sixteen rooms of
   * struct Room (416 bytes each) put Params at about 11,360 bytes, well inside the 65,536 a uniform binding has.
   */
  slots: 16,
  /** Furniture boxes per room the uniform carries (a layout has at most this many). */
  furniture: 16,
  /** Stations per room (a layout has exactly this many). */
  stations: 8,
  /** The hub, m along u from the lot centre: the point just inside the doorway every route passes through. */
  hub: 11,
  /**
   * The aisles, m either side of the room's axis: someone found standing inside with no workday leg (let go there)
   * walks out along the nearer one to the hub. Every layout keeps them clear of anything but the back wall's pieces,
   * which nobody stands behind; a straight line to the hub could press them on the back of a table on the axis.
   */
  aisle: 3,
  /** A pedestrian's reach, m: the crowd's containment pad (crowd.wgsl pushOut's). */
  pad: 0.35,
  /**
   * How far beyond a piece of furniture's grown corner someone asked over across a room turns round it, m
   * (crowd.wgsl roomWay): clear of the grazing line, inside the 1.2 m gap between two racks.
   */
  round: 0.25,
} as const)

/** The crowd's workday, frozen. */
export const WORK = Object.freeze({
  /**
   * Workers per station, about: the share of the crowd with a workplace is set so that the 128 stations (sixteen rooms
   * of eight) have this many people each over a day (on shift WORK.shift / WORK.cycle of the time, so about one at a
   * station at once). A bigger crowd has a smaller share, never a crowded room.
   */
  perStation: 1.6,
  /** The largest share there is: one pedestrian in this many, whatever the crowd's size. */
  minOneIn: 8,
  /**
   * Coprime with the 128 stations (29 is odd, 128 a power of two): the w-th worker is dealt station w × deal mod 128,
   * every station once before any twice. It was 29 for the 48 stations of six rooms too, and stays: 29 is coprime
   * with 128 as it was with 48.
   */
  deal: 29,
  /** A worker's day, s: the shift, then the rest of the cycle off duty on the streets. */
  cycle: 480,
  shift: 300,
  /**
   * The last leg's arrival, m: a worker reaching their station is at work this close. Wider than the crowd's
   * separation lets two people stand (about 0.65 m), so a second worker dealt an occupied station sits down beside
   * the first instead of waiting behind them; the working spring then holds both at the desk.
   */
  seat: 0.9,
  /** Hash salt of the worker lottery, its station and its shift's start (crowd.wgsl WORK_SALT). */
  salt: 0x7f4a7c15,
} as const)

/**
 * The sixteen workplace kinds, in station-slot order: the index is the kind's stable id (the crowd's station slots,
 * the uniform's room slots, the flat tables and the console's `rooms` all count by it), so a kind is never moved and
 * a new one goes on the end. Six of them are the first rooms the city had under other names: roboticsLab and
 * warehouse as they were, controlTower was telemetryCommand, twinStudio the boardroom, clearingFloor the legal
 * chambers and gaitLab the clinic; their furniture and stations are unchanged. consoleDeck is a room: the Sanctuary of
 * 07_Execute_Actions/sanctuary.ts is the First Law's shield inside Rapier and has nothing to do with it.
 */
export const WORKPLACE_KINDS = [
  'roboticsLab', 'warehouse', 'serverVault', 'metroOps', 'controlTower', 'kitchen', 'microFab', 'twinStudio',
  'fleetBay', 'greenhouse', 'acousticsLab', 'responseCenter', 'clearingFloor', 'gaitLab', 'microgrid', 'consoleDeck',
] as const
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

// ---------------------------------------------------------------- the sixteen layouts

/** A row of four pieces along u (the four bays at u = −9, −5, −1, 3), each `along` long, between v0 and v1. */
const bays = (v0: number, v1: number, y0: number, y1: number, style: number, along = 3): Piece[] =>
  [-9, -5, -1, 3].map((u) => ({ local: [u - along / 2, v0, u + along / 2, v1, y0, y1], style }))
/** Four stations along a row at v, facing fv (towards the furniture beyond). */
const row = (v: number, fv: 1 | -1, task: Task): LocalStation[] => [-9, -5, -1, 3].map((u) => ({ u, v, fu: 0, fv, task }))

/**
 * The layouts, in the room's frame, in WORKPLACE_KINDS order. Every one keeps the hub's cross aisle (u = ROOM.hub,
 * |v| ≤ 5) and the station rows (v = ±4.6, or ±3 round the twin studio's table) clear of furniture by more than a
 * pedestrian's reach, so the route doorway → hub → row → station is a straight walk on each leg (interiors.test.ts
 * holds that for every station). The rules every piece keeps, so the tests' walkers never stall:
 * - a piece beside a station row stands at |v| ≥ 5.6 (the row at 4.6, the reach 0.35, a tenth to spare), and a piece
 *   between the rows within |v| ≤ 2.4 (the aisles at ±3 stay clear by more than the reach) unless it touches the back
 *   wall (u0 ≤ −12.3), which nobody stands behind;
 * - a piece in a station's row ends at u ≤ −9.6 (the first station at −9) and nothing stands past u = 5 towards the
 *   doorway, so a slide along any face towards the hub comes off its end into open floor;
 * - a back-wall piece that spans a bay row's v ends at u ≤ −11.5 when the row's first bay starts at u ≥ −10.5: grown
 *   by the reach, its face (−11.15) is then behind the bay's (−10.85 at most), so someone sliding along the bay towards
 *   the room's axis never meets the back-wall piece's side and stands in the corner (the first kitchen's cold store
 *   reached −10.3 and pinned a walker let go at (−12, −9) there); a piece beside a back-wall piece's end starts at
 *   u ≥ −10.5 for the same reason;
 * - a column standing on a counter sits inside the counter's footprint (the robotics lab's arm columns), never behind
 *   it, where its side and the counter's back would meet in a corner;
 * - a piece running along a side wall ends at |v| ≤ 10.4 (the robotics lab's rack): the flow grid rasterises a box
 *   grown by FLOW.pad (0.5) over 2 m cells whose centres fall on odd metres, so the row of cells at |v| = 11 stays open,
 *   and an operator standing between the piece and the glass has an open cell indoors, which leads the recruit on the
 *   sidewalk round by the doorway instead of to the glass opposite them (the first micro-fab's rail reached 10.6 and
 *   pinned every recruit there); a piece touching the wall itself (|v| ≥ 11.7, the acoustics lab's shaker tables) is
 *   no different from the wall;
 * - a back-wall piece ends at |v| ≤ 4 where a bay row starts at |v| = 5.6 (the clearing floor's vault), or spans past
 *   the row: grown by the reach, that leaves a 0.9 m corridor between its end and the first bay, which is where
 *   roomWay's corner (0.6 m off the bay) stands for someone asked over into the pocket behind the bay (the first
 *   greenhouse's pumps ended at 5 and left a 0.1 m notch nobody was led through);
 * - a row of pieces along u is four bays at u = −9, −5, −1, 3, each at most 3 m long, so the gaps between them are a
 *   metre or more and someone asked over can be led down one (crowd.wgsl roomWay rounds a corner at 0.6 m).
 */
function layouts(): Record<WorkplaceKind, Layout> {
  const { trim, concrete, masonry, deck, rail } = STYLE
  return {
    // 1. The robotics lab, as it was: the furniture and the stations of the first room the city had.
    roboticsLab: {
      name: 'Dexterous Robotics and Manipulator Lab',
      furniture: [
        // Four manipulator cells: a pedestal and the arm's column rising from it.
        ...bays(-8.2, -5.6, 0, 1.1, concrete, 2.4),
        ...[-9, -5, -1, 3].map((u): Piece => ({ local: [u - 0.3, -7.2, u + 0.3, -6.6, 1.1, 2.4], style: trim })),
        // Sensor calibration tables, a server rack along the wall behind them, telemetry terminals on the back wall.
        ...bays(5.6, 6.6, 0, 0.9, deck),
        { local: [-11, 9.6, 5, 10.4, 0, 2.2], style: rail },
        { local: [-12.3, -4, -11.7, 4, 0, 2.0], style: trim },
      ],
      stations: [...row(-4.6, -1, 'inspecting'), ...row(4.6, 1, 'typing')],
    },
    // 2. The warehouse, as it was.
    warehouse: {
      name: 'Automated Fulfillment and Forklift Warehouse',
      furniture: [
        // High-bay pallet racks, a conveyor sorting lane, AGV charging docks behind it (0.3 m: a step the operator takes).
        ...bays(-10.4, -5.6, 0, 3.8, masonry, 2.8),
        { local: [-10, 5.6, 4, 6.4, 0, 0.8], style: trim },
        ...[-9, -5, -1, 3].map((u): Piece => ({ local: [u - 0.6, 9.4, u + 0.6, 10.6, 0, 0.3], style: concrete })),
      ],
      stations: [...row(-4.6, -1, 'inspecting'), ...row(4.6, 1, 'typing')],
    },
    // 3. The server vault: a hot aisle and a cold aisle of racks, the chillers on the back wall, two coolant manifolds
    // with their valve actuators on the room's axis.
    serverVault: {
      name: 'Tier-4 Server Vault and Cooling Plant',
      furniture: [
        ...bays(-9.0, -5.6, 0, 2.2, rail, 2.8),
        ...bays(5.6, 9.0, 0, 2.2, rail, 2.8),
        { local: [-12.3, -10, -11.7, 10, 0, 2.6], style: concrete },
        { local: [-10.5, -1.2, -9.5, 1.2, 0, 1.4], style: trim },
        { local: [-6.5, -1.2, -5.5, 1.2, 0, 1.4], style: trim },
      ],
      stations: [...row(-4.6, -1, 'inspecting'), ...row(4.6, 1, 'typing')],
    },
    // 4. Metro operations: the signal board along the back wall (0.8 m off the floor: a display, not a cabinet), the
    // switch consoles, the dispatch desks, the line schematic table on the axis, the platform camera wall on one side.
    metroOps: {
      name: 'Lakefront Metro Operations and Dispatch Centre',
      furniture: [
        { local: [-12.3, -8, -11.7, 8, 0.8, 3.4], style: trim },
        ...bays(-7.2, -5.6, 0, 1.0, deck, 2.8),
        ...bays(5.6, 6.8, 0, 0.9, deck),
        { local: [-9, -1.5, -3, 1.5, 0, 0.9], style: masonry },
        { local: [-10.5, 9.6, 3, 10.4, 0, 2.4], style: rail },
      ],
      stations: [...row(-4.6, -1, 'typing'), ...row(4.6, 1, 'collaborating')],
    },
    // 5. The control tower, the telemetry command room as it was: the radar desks (a desk and its display bank), the
    // telemetry consoles, the traffic wall at the back.
    controlTower: {
      name: 'Air Traffic and Drone Swarm Control Tower',
      furniture: [
        ...bays(-7.0, -5.6, 0, 0.9, deck),
        ...bays(-6.6, -6.2, 0.9, 1.6, trim, 2.8),
        ...bays(5.6, 6.8, 0, 1.4, rail, 2.4),
        { local: [-12.3, -8, -11.7, 8, 0.6, 3.2], style: trim },
      ],
      stations: [...row(-4.6, -1, 'typing'), ...row(4.6, 1, 'typing')],
    },
    // 6. The kitchen: four induction islands, the prep counters with a prep arm's column standing on each, the plating
    // conveyor along one side, the cold store's doors along the back wall.
    kitchen: {
      name: 'Commercial Culinary and Automated Prep Line',
      furniture: [
        ...bays(-8.4, -5.6, 0, 0.95, concrete, 2.8),
        ...bays(5.6, 7.0, 0, 0.9, deck),
        ...[-9, -5, -1, 3].map((u): Piece => ({ local: [u - 0.3, 6.2, u + 0.3, 6.8, 0.9, 2.2], style: trim })),
        { local: [-10, 9.6, 4, 10.4, 0, 0.9], style: trim },
        { local: [-12.3, -6, -11.5, 6, 0, 2.8], style: concrete },
      ],
      stations: [...row(-4.6, -1, 'inspecting'), ...row(4.6, 1, 'collaborating')],
    },
    // 7. The micro-fab: four CNC cells, four wafer handlers, the gantry's floor rail along one side (its bridge rides
    // above head height and is no box), the cleanroom airlock on the back wall, a metrology bench on the axis.
    microFab: {
      name: 'Precision CNC and Cleanroom Micro-Fab',
      furniture: [
        ...bays(-9.0, -5.6, 0, 1.8, concrete, 2.8),
        ...bays(5.6, 7.0, 0, 1.6, trim, 2.4),
        { local: [-11, 9.4, 5, 10.4, 0, 0.5], style: rail },
        { local: [-12.3, -2, -10.9, 2, 0, 2.6], style: trim },
        { local: [-6, -1.0, -2, 1.0, 0, 0.9], style: deck },
      ],
      stations: [...row(-4.6, -1, 'inspecting'), ...row(4.6, 1, 'typing')],
    },
    // 8. The twin studio, the boardroom as it was: the drafting table the stations ring at v = ±3, and the digital
    // twin's load-simulator plinth by the door.
    twinStudio: {
      name: 'Civic Architecture and Digital Twin Studio',
      furniture: [
        { local: [-10, -1.8, -2, 1.8, 0, 0.75], style: deck },
        { local: [2, -0.8, 3.6, 0.8, 0, 1.0], style: trim },
      ],
      stations: [
        ...[-9, -6.5, -4, -1.5].map((u): LocalStation => ({ u, v: -3, fu: 0, fv: 1, task: 'collaborating' })),
        ...[-9, -6.5, -4, -1.5].map((u): LocalStation => ({ u, v: 3, fu: 0, fv: -1, task: 'collaborating' })),
      ],
    },
    // 9. The fleet bay: four lift platforms (0.4 m: a wall to a walker, and to the operator's 0.3 m autostep), the
    // charging cabinets, the swap robot's rail along one side, the battery rack on the back wall.
    fleetBay: {
      name: 'Autonomous Fleet Maintenance and Battery Swap Bay',
      furniture: [
        ...bays(-10.0, -5.6, 0, 0.4, concrete, 2.8),
        ...bays(5.6, 6.6, 0, 1.6, trim, 2.4),
        { local: [-10, 9.6, 4, 10.4, 0, 1.2], style: masonry },
        { local: [-12.3, -10, -11.7, 10, 0, 2.4], style: rail },
      ],
      stations: [...row(-4.6, -1, 'inspecting'), ...row(4.6, 1, 'typing')],
    },
    // 10. The greenhouse: two rows of grow towers (each carries its LED rig), the dosing pumps on the back wall, the
    // nutrient tank in the back corner, the seedling table on the axis.
    greenhouse: {
      name: 'Vertical Hydroponic and Agri-Tech Greenhouse',
      furniture: [
        ...bays(-9.4, -5.6, 0, 3.0, masonry, 2.6),
        ...bays(5.6, 9.4, 0, 3.0, masonry, 2.6),
        { local: [-12.3, -4, -11.5, 4, 0, 1.6], style: trim },
        { local: [-12.3, 9.8, -10.8, 11.6, 0, 2.4], style: concrete },
        { local: [-9, -1.2, -4, 1.2, 0, 0.9], style: deck },
      ],
      stations: [...row(-4.6, -1, 'inspecting'), ...row(4.6, 1, 'inspecting')],
    },
    // 11. The acoustics chamber: the anechoic chamber on the back wall (its face at −9.6, 0.6 m from the first
    // station), baffle panels along both side walls, four shaker tables, four analysis benches.
    acousticsLab: {
      name: 'Materials Testing and Acoustics Chamber',
      furniture: [
        { local: [-12.3, -4, -9.6, 4, 0, 3.6], style: concrete },
        { local: [-11, -12.3, 4, -11.7, 0, 3.0], style: trim },
        { local: [-11, 11.7, 4, 12.3, 0, 3.0], style: trim },
        ...bays(-8.2, -5.6, 0, 1.0, concrete, 2.4),
        ...bays(5.6, 6.6, 0, 0.9, deck),
      ],
      stations: [...row(-4.6, -1, 'inspecting'), ...row(4.6, 1, 'typing')],
    },
    // 12. The response centre: the weather grid along the back wall, two rows of dispatch terminals, the incident
    // model table on the axis, the supply shelving along one side.
    responseCenter: {
      name: 'Emergency Response and Disaster Recovery Sim Centre',
      furniture: [
        { local: [-12.3, -9, -11.7, 9, 0.6, 3.4], style: trim },
        ...bays(-7.0, -5.6, 0, 0.9, deck),
        ...bays(5.6, 7.0, 0, 0.9, deck),
        { local: [-10, -2.0, -3, 2.0, 0, 0.9], style: masonry },
        { local: [-10.5, 9.6, 2, 10.4, 0, 2.2], style: rail },
      ],
      stations: [...row(-4.6, -1, 'typing'), ...row(4.6, 1, 'typing')],
    },
    // 13. The clearing floor, the legal chambers as they were: settlement terminals, the ledger vault against the
    // back wall, the clearing desks.
    clearingFloor: {
      name: 'Financial and Smart-Contract Clearing Floor',
      furniture: [
        ...bays(-7.4, -5.6, 0, 1.1, trim, 2.6),
        { local: [-12.3, -4, -9.5, 4, 0, 2.6], style: masonry },
        ...bays(5.6, 6.6, 0, 0.9, deck),
      ],
      stations: [...row(-4.6, -1, 'typing'), ...row(4.6, 1, 'collaborating')],
    },
    // 14. The gait lab, the clinic as it was: two gait capture volumes, four fitting desks, the prosthetics
    // dispensers along the back wall.
    gaitLab: {
      name: 'Biomedical Prosthetics and Gait Calibration Lab',
      furniture: [
        { local: [-9.5, -9.4, -6.5, -5.6, 0, 2.2], style: concrete },
        { local: [-3.5, -9.4, -0.5, -5.6, 0, 2.2], style: concrete },
        ...bays(5.6, 6.6, 0, 0.9, deck),
        { local: [-12.3, -3, -11.7, 3, 0, 2.2], style: trim },
      ],
      stations: [...row(-4.6, -1, 'inspecting'), ...row(4.6, 1, 'typing')],
    },
    // 15. The microgrid room: four transformer relay cabinets, four inverters, the switchgear along the back wall,
    // the battery bank along one side, the control desk on the axis.
    microgrid: {
      name: 'Renewable Microgrid and Substation Control Room',
      furniture: [
        ...bays(-9.2, -5.6, 0, 2.4, concrete, 2.6),
        ...bays(5.6, 7.0, 0, 1.8, rail, 2.4),
        { local: [-12.3, -9, -11.5, 9, 0, 2.6], style: trim },
        { local: [-10.5, 9.4, 3, 10.4, 0, 2.0], style: masonry },
        { local: [-7, -1.4, -3.4, 1.4, 0, 0.9], style: deck },
      ],
      stations: [...row(-4.6, -1, 'inspecting'), ...row(4.6, 1, 'typing')],
    },
    // 16. The console deck: the mainframe plinth on the back wall, the console ring in two arcs of four, a glass data
    // pillar along each side.
    consoleDeck: {
      name: 'The Sanctuary: Ring-0 Executive Console Deck',
      furniture: [
        { local: [-12.3, -2.4, -9.6, 2.4, 0, 3.2], style: trim },
        ...bays(-7.0, -5.6, 0, 0.9, deck, 2.8),
        ...bays(5.6, 7.0, 0, 0.9, deck, 2.8),
        { local: [-11, -10.4, 2, -9.6, 0, 3.0], style: rail },
        { local: [-11, 9.6, 2, 10.4, 0, 3.0], style: rail },
      ],
      stations: [...row(-4.6, -1, 'typing'), ...row(4.6, 1, 'typing')],
    },
  }
}

// ---------------------------------------------------------------- the lots and the rooms

/**
 * The seed's workplace lots: one per kind, each in its own sixteenth of the downtown (four columns of lots by four
 * rows: three lots across each column, three or four down each row), never the ring, the heritage quarter, the
 * lakefront rows or the park, so every room has four streets and a doorway side the dice may pick freely, and every
 * lot a podium to hollow (city.ts downtownLot builds one on every downtown lot). Lots and sides from the seed alone;
 * sixteen different lots, since the cells are disjoint.
 */
export function workplaceLots(seed: number): WorkplaceLot[] {
  const rng = createRng(seed ^ 0x1a7e)
  const k0 = HERITAGE_COLUMNS, k1 = CITY.blocks // downtown columns [k0, k1)
  const m0 = 0, m1 = CITY.blocks - 2 // downtown rows [m0, m1): the lakefront row and the park are below
  const cols = 4, rows = 4
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

/** A workplace's lot: its kind, the lot (between streets k and k + 1, m and m + 1) and its doorway's street front. */
export interface WorkplaceLot { kind: WorkplaceKind; k: number; m: number; side: Side }

/** The seed's sixteen workplaces, geometry and all. `podium` gives a lot's podium height (the ceiling slab's top). */
export function workplaces(seed: number, podium: (k: number, m: number) => number = () => ROOM.height + 1): Workplace[] {
  return workplacesAt(workplaceLots(seed), podium)
}

/**
 * The workplaces on the given lots, geometry and all: the city's from its seed (workplaces), or a region's lots chosen
 * from its pack (region/workplaces.ts), which the physics worker receives as plain data and builds the same rooms
 * from. At most ROOM.slots of them; the order is the station slots'. `podium` gives a lot's podium height.
 */
export function workplacesAt(lots: readonly WorkplaceLot[], podium: (k: number, m: number) => number = () => ROOM.height + 1): Workplace[] {
  const L = layouts()
  const h = CITY.lotHalf, w = ROOM.wall, inner = h - w
  return lots.map(({ kind, k, m, side }) => {
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
export function doorFront(room: { cx: number; cz: number; side: Side }, lane: number = CITY.lane): { x: number; z: number } {
  return toWorld(room, CITY.pitch / 2 - lane, 0)
}

/**
 * The legs of the walk from the door front to station `s`: through the doorway to the hub, across to the station's
 * row, along the row to the station. Leaving is the same walk backwards. `lane` is the street's pedestrian lane, the
 * one the shader is compiled with (the city's CITY.lane, a region window's WINDOW_GEOMETRY.lane): the door front is on it.
 */
export function routeIn(room: Workplace, s: number, lane: number = CITY.lane): { x: number; z: number }[] {
  const st = room.stations[s]
  return [doorFront(room, lane), toWorld(room, ROOM.hub, 0), toWorld(room, ROOM.hub, st.v), { x: st.x, z: st.z }]
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

/**
 * A room's glass in its own frame, [u0, v0, u1, v1] (crowd.wgsl pane): the back wall, the two side walls, and the
 * doorway's wall either side of the opening, as the shell builds them.
 */
export function glassPanes(): readonly (readonly [number, number, number, number])[] {
  const h = CITY.lotHalf, i = h - ROOM.wall, d = ROOM.door
  return [[-h, -h, -i, h], [-i, -h, i, -i], [-i, i, i, h], [i, -h, h, -d], [i, d, h, h]]
}

/**
 * Whether the segment from a to a + d passes through the open box (lo, hi) (crowd.wgsl hitsBox): a slab test. A segment
 * along a face, or one that only touches it, does not.
 */
export function hitsBox(a: { u: number; v: number }, d: { u: number; v: number }, lo: { u: number; v: number }, hi: { u: number; v: number }): boolean {
  let t0 = 0, t1 = 1
  if (Math.abs(d.u) < 1e-6) {
    if (a.u <= lo.u || a.u >= hi.u) return false
  } else {
    const ta = (lo.u - a.u) / d.u, tb = (hi.u - a.u) / d.u
    t0 = Math.max(t0, Math.min(ta, tb)); t1 = Math.min(t1, Math.max(ta, tb))
  }
  if (Math.abs(d.v) < 1e-6) {
    if (a.v <= lo.v || a.v >= hi.v) return false
  } else {
    const ta = (lo.v - a.v) / d.v, tb = (hi.v - a.v) / d.v
    t0 = Math.max(t0, Math.min(ta, tb)); t1 = Math.min(t1, Math.max(ta, tb))
  }
  return t0 < t1
}

/**
 * Whether the segment from a to b (city metres) crosses the room's glass, each pane grown by `pad` (crowd.wgsl
 * crossesGlass): exact, in the room's frame, where the panes are boxes, so a line that clips a jamb's corner by a
 * millimetre crosses it and one through the opening does not. The crowd asks it whether two people see each other
 * (walled) and whether a last stretch cuts a room's containment; a car's driver is never put out where the line from
 * the chassis reaches only through glass (carRig.ts exitPoint).
 */
export function crossesGlass(room: { cx: number; cz: number; side: Side }, a: { x: number; z: number }, b: { x: number; z: number }, pad = 0): boolean {
  const p = toLocal(room, a.x, a.z), q = toLocal(room, b.x, b.z)
  const d = { u: q.u - p.u, v: q.v - p.v }
  return glassPanes().some(([u0, v0, u1, v1]) => hitsBox(p, d, { u: u0 - pad, v: v0 - pad }, { u: u1 + pad, v: v1 + pad }))
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

// ---------------------------------------------------------------- the minimap

/** What drawRooms needs of a canvas: a fill colour and rectangles (a CanvasRenderingContext2D is one). */
export interface RoomCanvas {
  fillStyle: string | object
  fillRect(x: number, y: number, w: number, h: number): void
}

/**
 * The rooms within `radius` metres of (x, z) on a minimap already in the engine's metres (the HUD's city map, a
 * region's map layer after its buildings and streets): the lot in the accent colour, its floor inside the walls, and
 * the doorway cut through on its street front in the floor's colour, so the way in reads on the map.
 */
export function drawRooms(ctx: RoomCanvas, rooms: readonly Workplace[], x: number, z: number, dark: boolean, radius = 150): void {
  const lotHalf = CITY.lotHalf
  for (const r of rooms) {
    if (Math.abs(r.cx - x) > radius || Math.abs(r.cz - z) > radius) continue
    ctx.fillStyle = dark ? '#b45309' : '#f59e0b'
    ctx.fillRect(r.cx - lotHalf, r.cz - lotHalf, lotHalf * 2, lotHalf * 2)
    const inner = lotHalf - ROOM.wall * 3
    ctx.fillStyle = dark ? '#451a03' : '#fef3c7'
    ctx.fillRect(r.cx - inner, r.cz - inner, inner * 2, inner * 2)
    const d = doorDir(r.side)
    const w = ROOM.door * 2, depth = lotHalf - inner + 0.2
    const gx = r.cx + d.x * (lotHalf - depth / 2), gz = r.cz + d.z * (lotHalf - depth / 2)
    const [gw, gh] = d.x !== 0 ? [depth, w] : [w, depth]
    ctx.fillRect(gx - gw / 2, gz - gh / 2, gw, gh)
  }
}

// ---------------------------------------------------------------- the flat tables (for a swarm that dispatches by slot)

/**
 * The layout of workplaceTable: one row of `stride` floats per kind slot (ROOM.slots rows, WORKPLACE_KINDS order),
 * the fields in this order. kind is the slot's index in WORKPLACE_KINDS, or −1 for a slot this world has no room for
 * (a region with fewer lots), whose row is otherwise zero; x, y, z are the lot's centre in engine metres (y = 0: the
 * floor); doorX, doorZ the doorway's centre on the wall's outer face; doorYaw the heading from the doorway into the
 * room (atan2(x, z), the crowd's heading: forward is (sin yaw, cos yaw)); stations how many stations the room has
 * (ROOM.stations). Frozen: another thread reads rows by it (window.__SIM__.engine.workplaceTable).
 */
export const WORKPLACE_TABLE = Object.freeze({ stride: 8, fields: Object.freeze(['kind', 'x', 'y', 'z', 'doorX', 'doorZ', 'doorYaw', 'stations'] as const) })

/**
 * The layout of stationTable: ROOM.slots × ROOM.stations rows of `stride` floats, slot `r`'s station `s` at row
 * r × ROOM.stations + s (the crowd's station slot), each where to stand in engine metres (y = 0) and the way to face
 * (yaw as above); an empty slot's rows are zero.
 */
export const STATION_TABLE = Object.freeze({ stride: 4, fields: Object.freeze(['x', 'y', 'z', 'yaw'] as const), perRoom: ROOM.stations })

/**
 * The rooms as a flat table (WORKPLACE_TABLE): slot i is the room of kind WORKPLACE_KINDS[i] when `rooms` has one
 * (the city's sixteen, a region's first few: the same order the crowd's station slots count), kind −1 and zeros
 * where it has none. A caller's `out` must hold ROOM.slots × WORKPLACE_TABLE.stride floats; it is filled whole.
 */
export function workplaceTable(rooms: readonly Workplace[], out = new Float32Array(ROOM.slots * WORKPLACE_TABLE.stride)): Float32Array {
  const n = WORKPLACE_TABLE.stride
  if (out.length < ROOM.slots * n) throw new RangeError(`the workplace table is ${ROOM.slots * n} floats, got ${out.length}`)
  out.fill(0)
  for (let i = 0; i < ROOM.slots; i++) out[i * n] = -1
  for (const room of rooms) {
    const i = WORKPLACE_KINDS.indexOf(room.kind)
    if (i < 0) continue
    const o = i * n, d = doorDir(room.side)
    out[o] = i; out[o + 1] = room.cx; out[o + 2] = 0; out[o + 3] = room.cz
    out[o + 4] = room.door.x; out[o + 5] = room.door.z; out[o + 6] = Math.atan2(-d.x, -d.z); out[o + 7] = room.stations.length
  }
  return out
}

/** The rooms' stations as a flat table (STATION_TABLE), in the same slot order as workplaceTable; empty slots zero. */
export function stationTable(rooms: readonly Workplace[], out = new Float32Array(ROOM.slots * ROOM.stations * STATION_TABLE.stride)): Float32Array {
  const n = STATION_TABLE.stride
  if (out.length < ROOM.slots * ROOM.stations * n) throw new RangeError(`the station table is ${ROOM.slots * ROOM.stations * n} floats, got ${out.length}`)
  out.fill(0)
  for (const room of rooms) {
    const i = WORKPLACE_KINDS.indexOf(room.kind)
    if (i < 0) continue
    if (room.stations.length > ROOM.stations) throw new RangeError(`${room.kind}: too many stations`)
    room.stations.forEach((s, k) => {
      const o = (i * ROOM.stations + k) * n
      out[o] = s.x; out[o + 1] = 0; out[o + 2] = s.z; out[o + 3] = s.yaw
    })
  }
  return out
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
 * them is dealt station w × WORK.deal mod 128: every station once before any twice, the rooms in turn.
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
