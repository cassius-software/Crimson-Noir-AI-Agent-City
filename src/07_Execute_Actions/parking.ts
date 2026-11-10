// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It lays out the kerbside parking bays and seats the fleet's parked share in them
 * (carRig.ts planFleet), so there is always a car with nobody at its wheel for a player to take: the only car a
 * player may enter is a parked one (simCore.ts #interact, garage.node.ts whyNotEnter), and no car is ever taken from
 * its driver. A bay is on the sidewalk's inner strip, BAYS.lateral from the street's centreline on the right-hand
 * side of the travel direction (the asphalt ends at CITY.roadHalf, the lots start at CITY.pitch / 2 − CITY.lotHalf),
 * at one of BAYS.stations along each block side: clear of the lamps at 10 m and 30 m and the tree at 20 m
 * (city.ts streetFurniture), and more than vehicles.ts ON_LANE off the ring's lane at TRAFFIC.laneOffset, so the AI
 * traffic passes a bay without queueing behind it (the ring's order never counts it) and without its bonnet rays
 * finding it. A pedestrian whose way runs through a bay walks round the car (crowd.wgsl's detour,
 * crowdSoak.test.ts). Pure arithmetic on the street grid and a seat pose: the same numbers from the same seat on the
 * page and in the network room's garage, so both agree which cars are parked and where, and the seed's random stream
 * is never drawn from (the plan ahead of the parked share is as it was).
 * What breaks if it is removed? Every car would be in traffic, and taking one would mean taking it from its driver.
 */
import { CITY, type Box } from '../01_Initialize_World/city.ts'
import { TRAFFIC } from '../02_Define_The_Rules/civic.ts'
import type { TrackPose } from '../06_Make_Decisions/tracks.ts'
import { CAR } from './car.ts'

export const BAYS = Object.freeze({
  /**
   * A bay's centre from the street's centreline, m, on the kerb side of the lane: past the lane at TRAFFIC.laneOffset
   * by more than vehicles.ts ON_LANE (3 m), on the sidewalk strip between the asphalt (CITY.roadHalf) and the lots.
   */
  lateral: 5.2,
  /** Where a bay's centre may be along a block side, m from the block's first street line (between the lamps and the tree). */
  stations: Object.freeze([15, 25] as const),
  /** One car in this many of a fleet is seated in a bay: the last of every `share` of the plan. */
  share: 4,
  /** Round a parked car's footprint this much must hold no solid box (a surveyed region can build to the kerb), m. */
  clearance: 0.3,
} as const)

/** A parking bay: where the car's chassis centre stands and which way it faces, and the bay's name (one car per bay). */
export interface Bay {
  readonly x: number
  readonly y: number
  readonly z: number
  /** The travel direction of the lane beside it (atan2(tangentX, tangentZ), as TrackPose). */
  readonly heading: number
  readonly key: string
}

/** Whether car `index` of a fleet of `count` is seated in a bay: the last quarter, so every earlier slot is as before. */
export function inBays(index: number, count: number): boolean {
  return index >= count - Math.floor(count / BAYS.share)
}

/**
 * The free bay nearest a seat on a ring's straight: the kerb side of the seat's travel direction, at the nearest of
 * the block side's stations not in `used`, on the street grid whose north-west corner is `origin` (the city's is 0, 0;
 * a region's street window has its own). Null when both stations are taken or the seat is not on a straight.
 */
export function bayNear(pose: TrackPose, used: ReadonlySet<string>, origin: { x: number; z: number } = { x: 0, z: 0 }): Bay | null {
  const { tangentX: tx, tangentZ: tz } = pose
  // Straights are axis-aligned: the street's axis is the tangent's larger component, the rest is a corner's lean.
  const alongX = Math.abs(tx) >= Math.abs(tz)
  const dir = Math.sign(alongX ? tx : tz)
  if (dir === 0) return null
  const along = alongX ? pose.x - origin.x : pose.z - origin.z
  const cross = alongX ? pose.z - origin.z : pose.x - origin.x
  const line = Math.round(cross / CITY.pitch)
  // tracks.ts right(d) = [−d[1], d[0]]: the kerb of travel along +x is +z, that of travel along +z is −x.
  const side = alongX ? dir : -dir
  const block = Math.floor(along / CITY.pitch)
  const at = (station: number): number => block * CITY.pitch + station
  const stations = [...BAYS.stations].sort((a, b) => Math.abs(along - at(a)) - Math.abs(along - at(b)))
  for (const station of stations) {
    const key = `${alongX ? 'z' : 'x'}${line}:${block}:${station}:${side > 0 ? '+' : '-'}`
    if (used.has(key)) continue
    const a = at(station), c = line * CITY.pitch + side * BAYS.lateral
    return { x: origin.x + (alongX ? a : c), y: pose.y, z: origin.z + (alongX ? c : a), heading: pose.heading, key }
  }
  return null
}

/** Whether nothing solid stands in bay `b`: no box at a car's height within BAYS.clearance of its footprint. */
export function bayClear(b: Bay, boxes: readonly Box[]): boolean {
  const alongX = Math.abs(Math.sin(b.heading)) >= Math.abs(Math.cos(b.heading))
  const hx = (alongX ? CAR.halfLength : CAR.halfWidth) + BAYS.clearance
  const hz = (alongX ? CAR.halfWidth : CAR.halfLength) + BAYS.clearance
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    if (y1 <= 0.2 || y0 >= 1.5) continue
    if (x1 > b.x - hx && x0 < b.x + hx && z1 > b.z - hz && z0 < b.z + hz) return false
  }
  return true
}

/** The lane a bay sits beside, as a sanity bound for tests: the bay is this far outside it, m. */
export const BAY_OFF_LANE = BAYS.lateral - TRAFFIC.laneOffset
