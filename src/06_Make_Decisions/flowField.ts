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

/**
 * A region's grid over its bounds: open ground, with its walls (x0, z0, x1, z1, height; five numbers each) blocked,
 * and its boxes as the city's are (a generated region's workplaces, regionWorld.ts hollowLots: the glass and the
 * furniture block, the ceiling slab and what it carries are walked under).
 */
export function regionGrid(bounds: { x0: number; z0: number; x1: number; z1: number }, walls: ArrayLike<number>, boxes: readonly Box[] = [], cell = FLOW.cell): FlowGrid {
  const w = Math.max(1, Math.ceil((bounds.x1 - bounds.x0) / cell)), h = Math.max(1, Math.ceil((bounds.z1 - bounds.z0) / cell))
  const grid = emptyGrid(w, h, bounds.x0, bounds.z0, cell)
  const segments: Box[] = []
  for (let k = 0; k + 4 < walls.length; k += 5) segments.push([walls[k], 0, walls[k + 1], walls[k + 2], 0, walls[k + 3]])
  blockBoxes(grid, segments)
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

/**
 * The nearest unblocked cell to (x, z) within `radius` cells (the cell itself first), or −1. Nearest by the distance to
 * each cell's centre, not by cell steps: someone against a room's glass, their own cell in the wall, is given the cell
 * on their side of it, never the one behind the glass that only a tie of steps could pick.
 */
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
      const ex = grid.originX + (i + 0.5) * grid.cell - x, ez = grid.originZ + (j + 0.5) * grid.cell - z
      const d = ex * ex + ez * ez
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
 * The eight neighbours of NEIGHBOURS as flat tables, in its order: the column step, the row step, the step's cost
 * before the cell's weight, and the unit direction of the step (the diagonals' components DIAGONAL_UNIT, as f32).
 * The two fast solvers below read these, never the tuples: an inner loop over a million cells cannot afford an
 * iterator and a destructuring per neighbour (solveFlow over the Lakefront Metro grid, 1.6 M cells, took half a
 * second that way; flowField.test.ts holds the tables to NEIGHBOURS and the solvers to the tuple form, bit for bit).
 */
export const NEIGHBOUR_DI: Int8Array = Int8Array.from(NEIGHBOURS, (n) => n[0])
export const NEIGHBOUR_DJ: Int8Array = Int8Array.from(NEIGHBOURS, (n) => n[1])
export const NEIGHBOUR_COST: Int32Array = Int32Array.from(NEIGHBOURS, (n) => (n[2] ? FLOW.diagonal : FLOW.straight))
export const NEIGHBOUR_DX: Float32Array = Float32Array.from(NEIGHBOURS, (n) => (n[2] ? n[0] * DIAGONAL_UNIT : n[0]))
export const NEIGHBOUR_DZ: Float32Array = Float32Array.from(NEIGHBOURS, (n) => (n[2] ? n[1] * DIAGONAL_UNIT : n[1]))

/**
 * The solvers' working set over the grid padded by one blocked cell on every side, so that every neighbour is an
 * index into it and never a bounds test: the padded weights, the padded costs, and the bucket queue's links (one
 * doubly linked list per bucket, threaded through two arrays indexed by cell). One per grid, kept across solves in a
 * WeakMap (the grid gone, the set goes with it), so a solve allocates nothing but its result once the grid is warm;
 * the weights are copied in again on every call, since a grid's weights may be written after it was built (blockBoxes).
 */
interface Workspace { pw: Uint8Array; pcost: Int32Array; next: Int32Array; prev: Int32Array }
const workspaces = new WeakMap<FlowGrid, Workspace>()

/** The grid's working set, its padded weights fresh. */
function workspace(grid: FlowGrid): Workspace {
  const { width, height, weight } = grid
  const stride = width + 2, n = stride * (height + 2)
  let w = workspaces.get(grid)
  if (!w || w.pw.length !== n) workspaces.set(grid, (w = { pw: new Uint8Array(n), pcost: new Int32Array(n), next: new Int32Array(n), prev: new Int32Array(n) }))
  const pw = w.pw
  pw.fill(0)
  for (let j = 0; j < height; j++) pw.set(weight.subarray(j * width, (j + 1) * width), (j + 1) * stride + 1)
  return w
}

/**
 * Each neighbour's offset in the padded index space of a grid `stride` wide, and the offsets of the two straight
 * cells a step passes between (for a straight step, the target itself and the cell stepped from: both open whenever
 * the step is considered, so one rule serves all eight: a step is open iff its target and both side cells are).
 */
function offsets(stride: number): { off: Int32Array; sideA: Int32Array; sideB: Int32Array } {
  const off = new Int32Array(8), sideA = new Int32Array(8), sideB = new Int32Array(8)
  for (let k = 0; k < 8; k++) {
    off[k] = NEIGHBOUR_DJ[k] * stride + NEIGHBOUR_DI[k]
    sideA[k] = NEIGHBOUR_DI[k]
    sideB[k] = NEIGHBOUR_DJ[k] * stride
  }
  return { off, sideA, sideB }
}

/**
 * The cost field by a bucket queue (Dial's algorithm: every edge weight is a small integer), in one call. Its fixed
 * point is the relaxation's: the least cost over every path, for every cell. The fast CPU path, and the one the
 * physics worker runs for every new goal when the field is not solved on the GPU: over the padded grid, with a ring
 * of buckets one longer than the costliest step (a diagonal into the heaviest cell) and each cell linked into the
 * bucket of its tentative cost, moved when it is lowered, so no cell is visited twice and nothing is allocated per
 * cell. Goals that are not integer cells of the grid, or are blocked, are ignored, as seedCost ignores them.
 */
export function solveDial(grid: FlowGrid, goals: readonly number[]): Int32Array {
  const { width, height, weight } = grid
  const cells = width * height
  const { pw, pcost, next, prev } = workspace(grid)
  const stride = width + 2
  const { off, sideA, sideB } = offsets(stride)
  const cost = NEIGHBOUR_COST
  pcost.fill(UNREACHED)
  let heaviest = 1
  for (let c = 0; c < cells; c++) heaviest = Math.max(heaviest, weight[c])
  const ring = FLOW.diagonal * heaviest + 1
  const head = new Int32Array(ring).fill(-1)
  let queued = 0
  for (const g of goals) {
    if (!(Number.isInteger(g) && g >= 0 && g < cells && weight[g] !== 0)) continue
    const i = g % width, p = ((g - i) / width + 1) * stride + i + 1
    if (pcost[p] === 0) continue
    pcost[p] = 0
    next[p] = head[0]
    prev[p] = -1
    if (head[0] !== -1) prev[head[0]] = p
    head[0] = p
    queued++
  }
  // Bucket d holds every cell whose tentative cost is d; a cell relaxed from it lands in a later bucket of the ring
  // (its cost grows by at least FLOW.straight and by less than the ring), so the list being walked is never written.
  for (let d = 0, slot = 0; queued > 0; d++, slot = slot + 1 === ring ? 0 : slot + 1) {
    let c = head[slot]
    if (c === -1) continue
    head[slot] = -1
    for (; c !== -1; c = next[c]) {
      queued--
      for (let k = 0; k < 8; k++) {
        const n = c + off[k]
        const w = pw[n]
        if (w * pw[c + sideA[k]] * pw[c + sideB[k]] === 0) continue
        const v = d + cost[k] * w
        const old = pcost[n]
        if (v >= old) continue
        if (old !== UNREACHED) {
          const pn = prev[n], nn = next[n]
          if (pn !== -1) next[pn] = nn
          else head[old % ring] = nn
          if (nn !== -1) prev[nn] = pn
          queued--
        }
        pcost[n] = v
        const s = v % ring
        next[n] = head[s]
        prev[n] = -1
        if (head[s] !== -1) prev[head[s]] = n
        head[s] = n
        queued++
      }
    }
  }
  const out = new Int32Array(cells)
  for (let j = 0; j < height; j++) out.set(pcost.subarray((j + 1) * stride + 1, (j + 1) * stride + 1 + width), j * width)
  return out
}

/**
 * The direction field from a cost field: per cell, the unit vector towards the neighbour of least cost that it may
 * step to (the first in NEIGHBOURS order on a tie), the diagonals as (±DIAGONAL_UNIT, ±DIAGONAL_UNIT); zero where the
 * cell is blocked, unreached, the goal, or no neighbour is cheaper. The same arithmetic as the shader's `direction`,
 * over the padded grid: the border and every blocked cell cost UNREACHED there, which no open neighbour's cost falls
 * below, so the one test left per neighbour is the step's own (target and side cells open).
 */
export function directions(grid: FlowGrid, cost: Int32Array, out = new Float32Array(2 * grid.width * grid.height)): Float32Array {
  const { width, height } = grid
  const { pw, pcost } = workspace(grid)
  const stride = width + 2
  const { off, sideA, sideB } = offsets(stride)
  pcost.fill(UNREACHED)
  for (let j = 0; j < height; j++) pcost.set(cost.subarray(j * width, (j + 1) * width), (j + 1) * stride + 1)
  for (let j = 0; j < height; j++) {
    for (let i = 0, p = (j + 1) * stride + 1, c = 2 * j * width; i < width; i++, p++, c += 2) {
      let dx = 0, dz = 0
      const own = pcost[p]
      if (pw[p] !== 0 && own < UNREACHED && own > 0) {
        let best = own
        for (let k = 0; k < 8; k++) {
          if (pw[p + off[k]] * pw[p + sideA[k]] * pw[p + sideB[k]] === 0) continue
          const n = pcost[p + off[k]]
          if (n < best) {
            best = n
            dx = NEIGHBOUR_DX[k]
            dz = NEIGHBOUR_DZ[k]
          }
        }
      }
      out[c] = dx
      out[c + 1] = dz
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
