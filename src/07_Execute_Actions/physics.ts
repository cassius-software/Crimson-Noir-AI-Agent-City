// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It owns the Rapier3D world (WASM, SIMD build): static colliders for every
 * building box, lamp, tree and signal pole, the ground, and fixed-timestep stepping. Vehicles and the
 * player's character controller live in this one shared space. It is built and stepped only inside the
 * physics worker (simCore.ts), so the page never loads Rapier or holds a handle into this world. It also
 * measures the world: how long one world.step() takes, how many substeps a step ran, and how many bodies,
 * colliders and CCD bodies exist.
 * A surveyed region (?region) is built instead from its bounds and its walls: ground tiles over the whole region at
 * once, and the walls (every building wall, shoreline and region edge, as vertical triangles merged into one trimesh per
 * tile) streamed: only the tiles around where the player is (streamAt) exist, built as the player moves, so a region of
 * any size boots in the same time.
 * What breaks if it is removed? Cars fall through the ground and the player walks through walls.
 */
import RAPIER from '@dimforge/rapier3d-simd-compat'
import type { Box, Furniture } from '../01_Initialize_World/city.ts'
import { CITY_CENTER, POLES } from '../01_Initialize_World/city.ts'

export { RAPIER }

export const PHYSICS_HZ = 60
const MAX_SUBSTEPS = 4
/** castRay(…, true): the ground, the buildings, the seawall and the pier; no vehicle, person or furniture. */
const SOLID_FIXED = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS

export interface PhysicsStats {
  /** Exponential moving average of one world.step(), ms. */
  stepMs: number
  /** Substeps the last frame ran (0 when the accumulator had not filled a step). */
  steps: number
  bodies: number
  colliders: number
  /** Rigid bodies with continuous collision detection enabled. */
  ccd: number
}

/** The ground spans ±GROUND_EXTENT around the city centre. */
const GROUND_EXTENT = 1600
const GROUND_TILE = 50
const CORE = { min: -300, max: 750 } // 21 × 50 m tiles: the city, its building ring and a margin
/** Colliders the ground is made of: the tiled core plus the four outer slabs. */
export const GROUND_COLLIDERS = ((CORE.max - CORE.min) / GROUND_TILE) ** 2 + 4

/**
 * One 3.2 km ground box let Rapier's character controller sink 0.1–0.3 m into it (contact precision degrades
 * with extent), which a first-person eye height shows at once. 50 m tiles over the city and its margin keep the
 * feet at the controller's 2 cm offset; four large slabs carry the ground out to the full extent. Top face y = 0.
 */
function groundColliders(world: RAPIER.World, fixed: RAPIER.RigidBody): void {
  const slab = (x0: number, z0: number, x1: number, z1: number) =>
    world.createCollider(RAPIER.ColliderDesc.cuboid((x1 - x0) / 2, 0.5, (z1 - z0) / 2).setTranslation((x0 + x1) / 2, -0.5, (z0 + z1) / 2).setFriction(1.0), fixed)
  for (let x = CORE.min; x < CORE.max; x += GROUND_TILE) {
    for (let z = CORE.min; z < CORE.max; z += GROUND_TILE) slab(x, z, x + GROUND_TILE, z + GROUND_TILE)
  }
  const lo = CITY_CENTER - GROUND_EXTENT, hi = CITY_CENTER + GROUND_EXTENT
  slab(lo, lo, CORE.min, hi)
  slab(CORE.max, lo, hi, hi)
  slab(CORE.min, lo, CORE.max, CORE.min)
  slab(CORE.min, CORE.max, CORE.max, hi)
}

/**
 * A region as the physics worker builds it (01_Initialize_World/region/regionWorld.ts regionPhysics): its bounds in the
 * engine's frame, and every wall as five numbers, x0, z0, x1, z1 and height (m), standing on the ground.
 */
export interface RegionGround {
  bounds: { x0: number; z0: number; x1: number; z1: number }
  walls: ArrayLike<number>
}

/** Region ground tiles, m (the character controller keeps its skin on boxes this size), and their reach past the edge. */
export const REGION_GROUND_TILE = 200
const REGION_MARGIN = 100
/** Walls merge into one trimesh per tile this size, m; the tiles within this many tiles of the player are built. */
export const REGION_WALL_TILE = 250
export const REGION_WALL_REACH = 2

/** What a region's physics holds: its ground tiles, its wall tiles (built and waiting), and its walls. */
export interface RegionCounts { ground: number; wallTiles: number; builtTiles: number; walls: number; builtWalls: number }

/**
 * The region's walls by tile, built as the player moves: `streamAt` creates every tile within REGION_WALL_REACH tiles
 * of a point that does not exist yet (a tile takes milliseconds; a car at the speed cap crosses one in five seconds).
 * Built tiles stay.
 */
class WallStream {
  readonly counts: RegionCounts
  private readonly tiles = new Map<string, number[]>()
  private readonly built = new Set<string>()
  private readonly world: RAPIER.World
  private readonly fixed: RAPIER.RigidBody
  private lastKey = ''

  constructor(world: RAPIER.World, fixed: RAPIER.RigidBody, walls: ArrayLike<number>, ground: number) {
    this.world = world
    this.fixed = fixed
    const n = Math.floor(walls.length / 5)
    let kept = 0
    for (let i = 0; i < n; i++) {
      const ax = walls[5 * i], az = walls[5 * i + 1], bx = walls[5 * i + 2], bz = walls[5 * i + 3], h = walls[5 * i + 4]
      if (![ax, az, bx, bz, h].every(Number.isFinite) || h <= 0 || (ax === bx && az === bz)) continue
      // A wall belongs to every tile it touches, so a tile built alone never has a gap where a long wall crosses in.
      for (const key of tilesOf(ax, az, bx, bz)) {
        let list = this.tiles.get(key)
        if (!list) this.tiles.set(key, (list = []))
        list.push(ax, az, bx, bz, h)
      }
      kept++
    }
    this.counts = { ground, wallTiles: this.tiles.size, builtTiles: 0, walls: kept, builtWalls: 0 }
  }

  /** Builds every missing tile within reach of (x, z). Cheap when nothing is missing (one string per call). */
  at(x: number, z: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return
    const cx = Math.floor(x / REGION_WALL_TILE), cz = Math.floor(z / REGION_WALL_TILE)
    const key = `${cx},${cz}`
    if (key === this.lastKey) return
    this.lastKey = key
    for (let dx = -REGION_WALL_REACH; dx <= REGION_WALL_REACH; dx++) {
      for (let dz = -REGION_WALL_REACH; dz <= REGION_WALL_REACH; dz++) this.build(`${cx + dx},${cz + dz}`)
    }
  }

  private build(key: string): void {
    if (this.built.has(key)) return
    this.built.add(key)
    const list = this.tiles.get(key)
    if (!list) return
    const m = list.length / 5
    const v = new Float32Array(m * 12), idx = new Uint32Array(m * 6)
    for (let i = 0; i < m; i++) {
      const ax = list[5 * i], az = list[5 * i + 1], bx = list[5 * i + 2], bz = list[5 * i + 3], h = list[5 * i + 4]
      v.set([ax, 0, az, bx, 0, bz, bx, h, bz, ax, h, az], 12 * i)
      idx.set([4 * i, 4 * i + 1, 4 * i + 2, 4 * i, 4 * i + 2, 4 * i + 3], 6 * i)
    }
    this.world.createCollider(RAPIER.ColliderDesc.trimesh(v, idx), this.fixed)
    this.counts.builtTiles++
    this.counts.builtWalls += m
  }
}

/** The wall tiles a segment touches (its bounding box's tiles). */
function tilesOf(ax: number, az: number, bx: number, bz: number): string[] {
  const out: string[] = []
  for (let tx = Math.floor(Math.min(ax, bx) / REGION_WALL_TILE); tx <= Math.floor(Math.max(ax, bx) / REGION_WALL_TILE); tx++) {
    for (let tz = Math.floor(Math.min(az, bz) / REGION_WALL_TILE); tz <= Math.floor(Math.max(az, bz) / REGION_WALL_TILE); tz++) out.push(`${tx},${tz}`)
  }
  return out
}

/** The region's ground tiles, and its walls ready to stream. */
function regionColliders(world: RAPIER.World, fixed: RAPIER.RigidBody, r: RegionGround): WallStream {
  const { x0, z0, x1, z1 } = r.bounds
  let ground = 0
  const T = REGION_GROUND_TILE
  for (let x = Math.floor((x0 - REGION_MARGIN) / T) * T; x < x1 + REGION_MARGIN; x += T) {
    for (let z = Math.floor((z0 - REGION_MARGIN) / T) * T; z < z1 + REGION_MARGIN; z += T) {
      world.createCollider(RAPIER.ColliderDesc.cuboid(T / 2, 0.5, T / 2).setTranslation(x + T / 2, -0.5, z + T / 2).setFriction(1.0), fixed)
      ground++
    }
  }
  return new WallStream(world, fixed, r.walls, ground)
}

export class Physics {
  readonly world: RAPIER.World
  readonly stats: PhysicsStats = { stepMs: 0, steps: 0, bodies: 0, colliders: 0, ccd: 0 }
  private accumulator = 0
  private sampled = false
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })
  private ccdCount = 0
  private readonly countCcd = (body: RAPIER.RigidBody): void => {
    if (body.isCcdEnabled()) this.ccdCount++
  }

  private constructor(world: RAPIER.World) {
    this.world = world
  }

  /** With a region: its colliders' counts (the stream keeps them current). */
  get region(): RegionCounts | null {
    return this.walls?.counts ?? null
  }
  private walls: WallStream | null = null

  /** A region: builds the wall tiles around (x, z) that do not exist yet (see WallStream). Nothing in the city. */
  streamAt(x: number, z: number): void {
    this.walls?.at(x, z)
  }

  static async create(boxes: Box[], furniture: Furniture, region: RegionGround | null = null): Promise<Physics> {
    await RAPIER.init()
    return Physics.build(boxes, furniture, region)
  }

  /**
   * create() once Rapier's WebAssembly is loaded (any create() has loaded it): the same world, built synchronously.
   * The network room's authority builds a player's drive world this way the moment it is needed (garage.node.ts).
   */
  static build(boxes: Box[], furniture: Furniture, region: RegionGround | null = null): Physics {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    world.timestep = 1 / PHYSICS_HZ
    const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    if (region) {
      const p = new Physics(world)
      p.walls = regionColliders(world, fixed, region)
      world.step()
      return p
    }
    groundColliders(world, fixed)
    for (const [x0, y0, z0, x1, y1, z1] of boxes) {
      world.createCollider(
        RAPIER.ColliderDesc.cuboid((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2).setTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
        fixed,
      )
    }
    // Ghost mode: street furniture is in the world (ghost view draws it, a query can find it) but exchanges no
    // contact. The avatar and every car pass through lamps, trees and signal poles; the character controller,
    // the wheels, the AI's obstacle ray and the ground guard all exclude sensors.
    const pole = (x: number, z: number, h: number, r: number) =>
      world.createCollider(RAPIER.ColliderDesc.cylinder(h / 2, r).setTranslation(x, h / 2, z).setSensor(true), fixed)
    for (const [x, z] of furniture.lamps) pole(x, z, POLES.lamp.height, POLES.lamp.radius)
    for (const [x, z] of furniture.trees) pole(x, z, POLES.tree.height, POLES.tree.radius)
    for (const [x, z] of furniture.signals) pole(x, z, POLES.signal.height, POLES.signal.radius)
    // One step of the fixed world builds the query tree every query searches (the character controller's ground snap,
    // the wheels' rays, the AI's obstacle rays): an unstepped world has none, so the first substep's moves would miss
    // the ground. The network room's mirror and garage build their worlds here too, so all start alike.
    world.step()
    return new Physics(world)
  }

  /** Advances in fixed 1/60 s steps; `beforeStep` runs ahead of each (vehicle controllers update there). */
  step(dt: number, beforeStep: (h: number) => void): number {
    const h = 1 / PHYSICS_HZ
    this.accumulator = Math.min(this.accumulator + dt, h * MAX_SUBSTEPS)
    let steps = 0
    while (this.accumulator >= h) {
      beforeStep(h)
      const t0 = performance.now()
      this.world.step()
      const ms = performance.now() - t0
      // Seed the average with the first sample so it does not climb from zero.
      this.stats.stepMs = this.sampled ? this.stats.stepMs * 0.9 + ms * 0.1 : ms
      this.sampled = true
      this.accumulator -= h
      steps++
    }
    this.census(steps)
    return steps
  }

  /**
   * Distance along a ray to the first collider, excluding one rigid body (e.g. the caster). `filter`: true
   * hits only solid fixed geometry (not the street furniture's sensors); a QueryFilterFlags value is passed
   * through as is.
   */
  castRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxToi: number, exclude?: RAPIER.RigidBody, filter: boolean | RAPIER.QueryFilterFlags = false): number | null {
    const ray = this.ray
    ray.origin.x = ox; ray.origin.y = oy; ray.origin.z = oz
    ray.dir.x = dx; ray.dir.y = dy; ray.dir.z = dz
    const flags = filter === true ? SOLID_FIXED : filter === false ? undefined : filter
    const hit = this.world.castRay(ray, maxToi, true, flags, undefined, undefined, exclude)
    return hit ? hit.timeOfImpact : null
  }

  private census(steps: number): void {
    const s = this.stats
    s.steps = steps
    s.bodies = this.world.bodies.len()
    s.colliders = this.world.colliders.len()
    this.ccdCount = 0
    this.world.bodies.forEach(this.countCcd)
    s.ccd = this.ccdCount
  }
}
