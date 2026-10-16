// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the vector flow field the pedestrians route by: a grid over the city in which
 * every cell holds the unit direction to walk from there to reach the goal (the operator), going round the buildings
 * and preferring the sidewalk to the road. A pedestrian asked over samples the cell under their feet and walks that
 * way, so the whole crowd routes round walls with one field and no per-agent search; a wall is simply a cell nobody
 * may enter.
 *
 * Three things live here, all pure (no GPU, no DOM, no import but the city's constants):
 * - the grid (`FlowGrid`, `cityGrid`): cells of FLOW.cell metres, each with an entry weight: 0 for a building
 *   (blocked), 1 for the sidewalk, FLOW.roadWeight for the road, so a route crosses a street rather than walking
 *   down it;
 * - the integration field (`relaxStep`, `solveByRelaxation`, `solveDial`): the cost to reach the goal from every
 *   cell, in integer units (10 a straight step, 14 a diagonal, each times the cell's weight), by Jacobi relaxation
 *   over the eight neighbours (what flowField.wgsl does on the GPU, one pass per dispatch, so the two agree bit for
 *   bit) or by a bucket queue (Dial's algorithm) for a CPU that wants the answer in one call; the two solve to the
 *   same fixed point, and flowField.test.ts holds them equal;
 * - the direction field (`directions`): per cell, the unit vector to the lowest-cost neighbour (first in a fixed
 *   order on a tie), zero at the goal, in a wall, or where no route exists; the same arithmetic as the shader's.
 * The field reaches the crowd as an rg32float texture of width × height texels (the direction per cell), which
 * crowd.wgsl samples by the cell under a person's feet (`flowAt` here is the same lookup, for tests and the console).
 * What breaks if it is removed? A summoned pedestrian walks the straight line to the operator and stops at the
 * first wall across it; the GPU solver has no reference to be checked against.
 */
import { CITY, CITY_SIZE, type Box } from '../01_Initialize_World/city.ts'

/** The field's tuning: policy about how people route, frozen. */
export const FLOW = Object.freeze({
  /** Cell size, m: a sidewalk is a lane of them (CITY.lotHalf to CITY.roadHalf leaves 3 m); a block is twenty across. */
  cell: 2,
  /** How much further a road cell counts than a sidewalk cell: a route crosses the street, it does not walk down it. */
  roadWeight: 3,
  /** Metres a building is grown by before it is rasterised: a person's reach, so a route never hugs a wall. */
  pad: 0.5,
  /** A box whose underside is this high, m, is walked under (a room's ceiling slab, a cornice): it blocks nothing. */
  headroom: 2.0,
  /** Cost of a straight step and of a diagonal one, before the cell's weight (14/10 ≈ √2, in integers). */
  straight: 10,
  diagonal: 14,
} as const)

/** A cell no route has reached (and a wall's cost): the largest value the GPU and the CPU agree on, 2^30 − 1. */
export const UNREACHED = 0x3fffffff

/**
 * A grid of width × height cells, cell (i, j) at index j × width + i covering x ∈ [originX + i·cell, +cell) and
 * z ∈ [originZ + j·cell, +cell), with each cell's entry weight (0: blocked).
 */
export interface FlowGrid {
  readonly width: number
  readonly height: number
  readonly originX: number
  readonly originZ: number
  readonly cell: number
  /** Per cell: 0 blocked, else the weight a step into it is multiplied by. */
  readonly weight: Uint8Array
}

/** A direction field over a grid: cost per cell (UNREACHED where none) and the unit direction (2 floats per cell). */
export interface FlowSolution { cost: Int32Array; dir: Float32Array }

/** The eight neighbours in the fixed order both solvers use: the four straight ones first, then the diagonals. */
export const NEIGHBOURS: readonly (readonly [di: number, dj: number, diagonal: boolean])[] = Object.freeze([
  [1, 0, false], [-1, 0, false], [0, 1, false], [0, -1, false],
  [1, 1, true], [-1, 1, true], [1, -1, true], [-1, -1, true],
] as const)

/** 1/√2 as the GPU computes it in f32 (the diagonal's unit components). */
export const DIAGONAL_UNIT = Math.fround(Math.SQRT1_2)

/** An empty grid (every cell sidewalk) of these dimensions. */
export function emptyGrid(width: number, height: number, originX = 0, originZ = 0, cell = FLOW.cell): FlowGrid {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width * height <= 1 << 22)) throw new RangeError('a flow grid is at most 4 M cells')
  if (!(cell > 0 && Number.isFinite(cell) && Number.isFinite(originX) && Number.isFinite(originZ))) throw new RangeError('a flow grid needs a finite origin and a positive cell')
  return { width, height, originX, originZ, cell, weight: new Uint8Array(width * height).fill(1) }
}

/**
 * Marks every cell whose centre lies in a box ([minX, minY, minZ, maxX, maxY, maxZ]) grown by `pad` as blocked. The
 * centre, not any overlap: a cell half on the sidewalk stays a cell people may walk, so a lane survives beside every lot.
 * A box that starts at FLOW.headroom or above is walked under (the ceiling slab over a workplace's room, interiors.ts)
 * and blocks nothing; a region's walls (y 0 to 0) and every box on the ground block as they always did.
 */
export function blockBoxes(grid: FlowGrid, boxes: readonly Box[], pad = FLOW.pad): void {
  const { width, height, originX, originZ, cell, weight } = grid
  for (const [x0, y0, z0, x1, , z1] of boxes) {
    if (![x0, z0, x1, z1].every(Number.isFinite)) continue
    if (y0 >= FLOW.headroom) continue
    const lx = Math.min(x0, x1) - pad, hx = Math.max(x0, x1) + pad, lz = Math.min(z0, z1) - pad, hz = Math.max(z0, z1) + pad
    const i0 = Math.max(0, Math.floor((lx - originX) / cell - 0.5)), i1 = Math.min(width - 1, Math.ceil((hx - originX) / cell - 0.5))
    const j0 = Math.max(0, Math.floor((lz - originZ) / cell - 0.5)), j1 = Math.min(height - 1, Math.ceil((hz - originZ) / cell - 0.5))
    for (let j = j0; j <= j1; j++) {
      const cz = originZ + (j + 0.5) * cell
      if (cz < lz || cz > hz) continue
      for (let i = i0; i <= i1; i++) {
        const cx = originX + (i + 0.5) * cell
        if (cx >= lx && cx <= hx) weight[j * width + i] = 0
      }
    }
  }
}

/**
 * The procedural city's grid: CITY_SIZE square from the origin, the buildings blocked, and every cell whose centre is
 * within CITY.roadHalf of a street centreline (x or z a multiple of CITY.pitch) weighted as road.
 */
export function cityGrid(boxes: readonly Box[], cell = FLOW.cell): FlowGrid {
  const n = Math.ceil(CITY_SIZE / cell)
  const grid = emptyGrid(n, n, 0, 0, cell)
  const onRoad = (c: number): boolean => {
    const m = ((c % CITY.pitch) + CITY.pitch) % CITY.pitch
    return Math.min(m, CITY.pitch - m) <= CITY.roadHalf
  }
  for (let j = 0; j < n; j++) {
    const road = onRoad((j + 0.5) * cell)
    for (let i = 0; i < n; i++) if (road || onRoad((i + 0.5) * cell)) grid.weight[j * n + i] = FLOW.roadWeight
  }
  blockBoxes(grid, boxes)
  return grid
}

/** A surveyed region's grid over its bounds: open ground, with its walls (x0, z0, x1, z1, height; five numbers each) blocked. */
export function regionGrid(bounds: { x0: number; z0: number; x1: number; z1: number }, walls: ArrayLike<number>, cell = FLOW.cell): FlowGrid {
  const w = Math.max(1, Math.ceil((bounds.x1 - bounds.x0) / cell)), h = Math.max(1, Math.ceil((bounds.z1 - bounds.z0) / cell))
  const grid = emptyGrid(w, h, bounds.x0, bounds.z0, cell)
  const boxes: Box[] = []
  for (let k = 0; k + 4 < walls.length; k += 5) boxes.push([walls[k], 0, walls[k + 1], walls[k + 2], 0, walls[k + 3]])
  blockBoxes(grid, boxes)
  return grid
}

/** The cell index under (x, z), or −1 outside the grid. */
export function cellAt(grid: FlowGrid, x: number, z: number): number {
  const i = Math.floor((x - grid.originX) / grid.cell), j = Math.floor((z - grid.originZ) / grid.cell)
  if (!(i >= 0 && i < grid.width && j >= 0 && j < grid.height)) return -1
  return j * grid.width + i
}

/** The centre of cell `c`. */
export function cellCentre(grid: FlowGrid, c: number): { x: number; z: number } {
  const i = c % grid.width, j = Math.floor(c / grid.width)
  return { x: grid.originX + (i + 0.5) * grid.cell, z: grid.originZ + (j + 0.5) * grid.cell }
}

/** The nearest unblocked cell to (x, z) within `radius` cells (the cell itself first), or −1. */
export function nearestOpen(grid: FlowGrid, x: number, z: number, radius = 3): number {
  const i0 = Math.min(grid.width - 1, Math.max(0, Math.floor((x - grid.originX) / grid.cell)))
  const j0 = Math.min(grid.height - 1, Math.max(0, Math.floor((z - grid.originZ) / grid.cell)))
  let best = -1, bestD = Infinity
  for (let dj = -radius; dj <= radius; dj++) {
    for (let di = -radius; di <= radius; di++) {
      const i = i0 + di, j = j0 + dj
      if (i < 0 || j < 0 || i >= grid.width || j >= grid.height) continue
      const c = j * grid.width + i
      if (grid.weight[c] === 0) continue
      const d = di * di + dj * dj
      if (d < bestD) { bestD = d; best = c }
    }
  }
  return best
}

/** The cost field seeded for `goals`: 0 at each (unblocked) goal cell, UNREACHED everywhere else. */
export function seedCost(grid: FlowGrid, goals: readonly number[], out: Int32Array = new Int32Array(grid.width * grid.height)): Int32Array {
  out.fill(UNREACHED)
  for (const g of goals) if (g >= 0 && g < out.length && grid.weight[g] !== 0) out[g] = 0
  return out
}

/**
 * Whether a step from cell (i, j) to (i + di, j + dj) may be taken: the target is inside and unblocked, and a
 * diagonal does not cut a blocked corner (both straight cells it passes between must be open).
 */
function open(grid: FlowGrid, i: number, j: number, di: number, dj: number, diagonal: boolean): boolean {
  const ni = i + di, nj = j + dj
  if (ni < 0 || nj < 0 || ni >= grid.width || nj >= grid.height) return false
  if (grid.weight[nj * grid.width + ni] === 0) return false
  if (diagonal && (grid.weight[j * grid.width + ni] === 0 || grid.weight[nj * grid.width + i] === 0)) return false
  return true
}

/**
 * One Jacobi relaxation pass, exactly as flowField.wgsl's `relax` entry point computes it: for every unblocked
 * cell, the new cost is the least of its old cost and, over every neighbour it may step from, that neighbour's cost
 * plus the step (straight or diagonal, times this cell's weight). A blocked cell stays UNREACHED. Reads `from`,
 * writes `to`; returns how many cells changed (0: the field has converged).
 */
export function relaxStep(grid: FlowGrid, from: Int32Array, to: Int32Array): number {
  const { width, height, weight } = grid
  let changed = 0
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const c = j * width + i
      const w = weight[c]
      if (w === 0) { to[c] = UNREACHED; continue }
      let best = from[c]
      for (const [di, dj, diagonal] of NEIGHBOURS) {
        if (!open(grid, i, j, di, dj, diagonal)) continue
        const n = from[(j + dj) * width + (i + di)]
        if (n >= UNREACHED) continue
        const v = n + (diagonal ? FLOW.diagonal : FLOW.straight) * w
        if (v < best) best = v
      }
      to[c] = best
      if (best !== from[c]) changed++
    }
  }
  return changed
}

/**
 * The cost field by relaxation until nothing changes (the reference for the GPU, which does the same passes). Returns
 * the field and the number of passes it took, the last one the pass that changed nothing.
 */
export function solveByRelaxation(grid: FlowGrid, goals: readonly number[], limit = 4 * (grid.width + grid.height)): { cost: Int32Array; passes: number } {
  let a: Int32Array = seedCost(grid, goals), b: Int32Array = new Int32Array(a.length)
  let passes = 0
  while (passes < limit) {
    passes++
    const changed = relaxStep(grid, a, b)
    const t = a; a = b; b = t
    if (changed === 0) return { cost: a, passes }
  }
  return { cost: a, passes }
}

/**
 * The cost field by a bucket queue (Dial's algorithm: every edge weight is a small integer), in one call. Its fixed
 * point is the relaxation's: the least cost over every path, for every cell. The fast CPU path.
 */
export function solveDial(grid: FlowGrid, goals: readonly number[]): Int32Array {
  const { width, weight } = grid
  const cost = seedCost(grid, goals)
  const buckets: (number[] | undefined)[] = []
  for (const g of goals) if (g >= 0 && g < cost.length && cost[g] === 0) (buckets[0] ??= []).push(g)
  for (let d = 0; d < buckets.length; d++) {
    const bucket = buckets[d]
    if (!bucket) continue
    for (let k = 0; k < bucket.length; k++) {
      const c = bucket[k]
      if (cost[c] !== d) continue
      const i = c % width, j = (c - i) / width
      for (const [di, dj, diagonal] of NEIGHBOURS) {
        if (!open(grid, i, j, di, dj, diagonal)) continue
        const n = (j + dj) * width + (i + di)
        const v = d + (diagonal ? FLOW.diagonal : FLOW.straight) * weight[n]
        if (v < cost[n]) {
          cost[n] = v
          ;(buckets[v] ??= []).push(n)
        }
      }
    }
    buckets[d] = undefined
  }
  return cost
}

/**
 * The direction field from a cost field: per cell, the unit vector towards the neighbour of least cost that it may
 * step to (the first in NEIGHBOURS order on a tie), the diagonals as (±DIAGONAL_UNIT, ±DIAGONAL_UNIT); zero where the
 * cell is blocked, unreached, the goal, or no neighbour is cheaper. The same arithmetic as the shader's `direction`.
 */
export function directions(grid: FlowGrid, cost: Int32Array, out = new Float32Array(2 * grid.width * grid.height)): Float32Array {
  const { width, height, weight } = grid
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const c = j * width + i
      let dx = 0, dz = 0
      const own = cost[c]
      if (weight[c] !== 0 && own < UNREACHED && own > 0) {
        let best = own
        for (const [di, dj, diagonal] of NEIGHBOURS) {
          if (!open(grid, i, j, di, dj, diagonal)) continue
          const n = cost[(j + dj) * width + (i + di)]
          if (n < best) {
            best = n
            dx = diagonal ? di * DIAGONAL_UNIT : di
            dz = diagonal ? dj * DIAGONAL_UNIT : dj
          }
        }
      }
      out[2 * c] = dx
      out[2 * c + 1] = dz
    }
  }
  return out
}

/** The whole CPU solve: cost by the bucket queue, then the directions. */
export function solveFlow(grid: FlowGrid, goals: readonly number[]): FlowSolution {
  const cost = solveDial(grid, goals)
  return { cost, dir: directions(grid, cost) }
}

/**
 * The direction under (x, z), as the shader samples it (crowd.wgsl flowAt: the cell under the point, zero outside the
 * grid or where the field has none).
 */
export function flowAt(grid: FlowGrid, dir: Float32Array, x: number, z: number): { x: number; z: number } {
  const c = cellAt(grid, x, z)
  return c < 0 ? { x: 0, z: 0 } : { x: dir[2 * c], z: dir[2 * c + 1] }
}

/**
 * Follows the direction field from (x, z) in steps of a cell until the goal (a zero direction) or `limit` steps:
 * the route a pedestrian would take. A test's oracle for "routes round the wall", and the console's `flow trace`.
 */
export function trace(grid: FlowGrid, dir: Float32Array, x: number, z: number, limit = 4 * (grid.width + grid.height)): { x: number; z: number }[] {
  const path: { x: number; z: number }[] = [{ x, z }]
  for (let k = 0; k < limit; k++) {
    const c = cellAt(grid, x, z)
    if (c < 0) break
    const dx = dir[2 * c], dz = dir[2 * c + 1]
    if (dx === 0 && dz === 0) break
    x += dx * grid.cell
    z += dz * grid.cell
    path.push({ x, z })
  }
  return path
}

/**
 * The solver the crowd asks for a field towards a goal: the GPU's (flowFieldGpu.ts, in the physics worker) or the
 * CPU's (`cpuFlowSolver`), the same field either way.
 */
export interface FlowSolver {
  readonly grid: FlowGrid
  /** Solves for the goal cells and lands the field where the pedestrians read it; resolves once it has landed. */
  solve(goals: readonly number[]): Promise<void>
}

/** The CPU solver: the field computed here, handed to `land` (the crowd's texture write) each time. */
export function cpuFlowSolver(grid: FlowGrid, land: (solution: FlowSolution) => void): FlowSolver {
  return Object.freeze({ grid, solve: async (goals: readonly number[]) => land(solveFlow(grid, goals)) })
}
