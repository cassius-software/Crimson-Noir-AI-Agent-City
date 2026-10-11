// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the flow field: the grid from the city's boxes and streets, the
 * two CPU solvers (relaxation, which the GPU repeats pass by pass, and the bucket queue) reaching the same costs on
 * random mazes, directions that route round a wall and prefer the sidewalk to the road, and the GPU wiring driven on a
 * mock device whose dispatches run the reference's own passes: the batches, the ping-pong, the early stop at a batch
 * that changed nothing, the direction pass into the texture, and the fallback. It also reads flowField.wgsl and holds
 * its constants, bindings and neighbour tables to the reference's.
 * What breaks if it is removed? The GPU field could drift from the CPU's, and a route into a wall would ship.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CITY, CITY_SIZE, type Box } from '../01_Initialize_World/city.ts'
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import {
  blockBoxes, cellAt, cellCentre, cityGrid, cpuFlowSolver, DIAGONAL_UNIT, directions, emptyGrid, FLOW, flowAt, NEIGHBOURS, nearestOpen,
  regionGrid, relaxStep, seedCost, solveByRelaxation, solveDial, solveFlow, trace, UNREACHED, type FlowGrid,
} from './flowField.ts'

// Vite's `?raw` import, for Node: the file as a default-exported string.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const USAGE = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 } as const
const TEXTURE_USAGE = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 } as const
Object.assign(globalThis, { GPUBufferUsage: USAGE, GPUMapMode: { READ: 1, WRITE: 2 }, GPUTextureUsage: TEXTURE_USAGE })
const { FLOW_BINDINGS, FLOW_WORKGROUP, FlowFieldGpu, RELAX_BATCH, createFlowTexture, flowShader, relaxLimit, writeFlowTexture } = await import('./flowFieldGpu.ts')

const SOURCE = readFileSync(new URL('./flowField.wgsl', import.meta.url), 'utf8')

/** A maze: a w × h grid with `density` of its cells blocked, from a seed. */
function maze(w: number, h: number, density: number, seed: number): FlowGrid {
  const rng = createRng(seed)
  const g = emptyGrid(w, h)
  for (let c = 0; c < w * h; c++) {
    const r = rng()
    if (r < density) g.weight[c] = 0
    else if (r < density + 0.2) g.weight[c] = FLOW.roadWeight
  }
  return g
}

test('the grid: cells of FLOW.cell metres from an origin, boxes grown by the pad blocked, the city streets weighted as road', () => {
  const g = emptyGrid(4, 3, 10, 20, 2)
  assert.equal(g.weight.length, 12)
  assert.equal(cellAt(g, 10, 20), 0)
  assert.equal(cellAt(g, 17.9, 25.9), 11)
  assert.equal(cellAt(g, 18, 20), -1, 'off the right edge')
  assert.equal(cellAt(g, 9.9, 20), -1)
  assert.deepEqual(cellCentre(g, 5), { x: 13, z: 23 })
  blockBoxes(g, [[12.4, 0, 20, 12.6, 5, 21]], 0.5)
  // x 11.9..13.1 holds the centre of cell i = 1 (13) and not i = 0 (11); z 19.5..21.5 holds row 0's centre (21) only.
  assert.deepEqual(Array.from(g.weight), [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
  assert.throws(() => emptyGrid(0, 1), RangeError)
  assert.throws(() => emptyGrid(3000, 3000), RangeError)

  const boxes: Box[] = [[100, 0, 100, 120, 30, 120]]
  const city = cityGrid(boxes)
  assert.equal(city.width, CITY_SIZE / FLOW.cell)
  assert.equal(city.height, city.width)
  assert.equal(city.cell, FLOW.cell)
  // A cell on a street centreline (x = pitch) is road; one in the middle of a block's sidewalk is not.
  assert.equal(city.weight[cellAt(city, CITY.pitch, CITY.pitch / 2)], FLOW.roadWeight)
  assert.equal(city.weight[cellAt(city, CITY.pitch + CITY.roadHalf + 1, CITY.pitch + CITY.roadHalf + 1)], 1)
  assert.equal(city.weight[cellAt(city, 110, 110)], 0, 'inside the box')
  assert.equal(city.weight[cellAt(city, 100.2, 110)], 0, 'the cell whose centre is within the pad of the box')
  assert.equal(city.weight[cellAt(city, 99, 110)], 1, 'the cell beside it, its centre outside the pad')

  const region = regionGrid({ x0: -8, z0: 4, x1: 8, z1: 12 }, [0, 4, 1, 12, 3])
  assert.equal(region.width, 8)
  assert.equal(region.height, 4)
  assert.equal(region.originX, -8)
  assert.equal(region.weight[cellAt(region, 0.5, 5)], 0, 'the wall')
  assert.equal(region.weight[cellAt(region, -7, 5)], 1)
})

test('relaxation and the bucket queue reach the same costs on random mazes, and the relaxation converges within the limit', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const g = maze(24 + seed, 17 + (seed % 5), 0.25, seed)
    const goals = [cellAt(g, 2 * FLOW.cell + 1, 2 * FLOW.cell + 1), g.weight.length - 1]
    const dial = solveDial(g, goals)
    const relaxed = solveByRelaxation(g, goals)
    assert.deepEqual(Array.from(relaxed.cost), Array.from(dial), `maze ${seed}`)
    assert.ok(relaxed.passes <= relaxLimit(g), `maze ${seed}: ${relaxed.passes} passes`)
    // Every blocked cell is UNREACHED; every goal that is open is 0; costs are in the step units.
    for (let c = 0; c < g.weight.length; c++) {
      if (g.weight[c] === 0) assert.equal(dial[c], UNREACHED)
      else if (dial[c] < UNREACHED) assert.equal(dial[c] % 2, 0)
    }
    for (const goal of goals) if (g.weight[goal] !== 0) assert.equal(dial[goal], 0)
  }
})

test('one relax pass is the reference step: a cell takes the least of itself and each neighbour plus the step times its weight', () => {
  const g = emptyGrid(3, 3)
  g.weight[4] = FLOW.roadWeight
  const from = seedCost(g, [0])
  const to = new Int32Array(9)
  assert.equal(relaxStep(g, from, to), 3, 'the three neighbours of the goal moved')
  assert.deepEqual(Array.from(to), [0, 10, UNREACHED, 10, 14 * FLOW.roadWeight, UNREACHED, UNREACHED, UNREACHED, UNREACHED])
  const again = new Int32Array(9)
  // The road cell in the middle is cheaper by the straight step from its neighbour (10 + 10 × 3) than by the diagonal
  // from the goal (14 × 3); the far corner is reached through it.
  assert.equal(relaxStep(g, to, again), 6)
  assert.deepEqual(Array.from(again), [0, 10, 20, 10, 40, 10 + 14, 20, 10 + 14, 42 + 14])
  const third = new Int32Array(9)
  assert.equal(relaxStep(g, again, third), 1, 'the far corner, now by a straight step from the side (24 + 10), not through the road')
  assert.deepEqual(Array.from(third), [0, 10, 20, 10, 40, 24, 20, 24, 34])
  assert.equal(relaxStep(g, third, again), 0, 'converged')
  // A blocked cell stays UNREACHED, and a diagonal never cuts a blocked corner.
  const w = emptyGrid(2, 2)
  w.weight[1] = 0
  w.weight[2] = 0
  const c0 = seedCost(w, [0]), c1 = new Int32Array(4)
  relaxStep(w, c0, c1)
  assert.deepEqual(Array.from(c1), [0, UNREACHED, UNREACHED, UNREACHED], 'cell 3 is diagonal through two blocked corners')
})

test('directions: the unit vector to the cheapest neighbour, diagonals at 1/√2, zero at the goal, in a wall and where no route exists', () => {
  const g = emptyGrid(5, 5)
  for (let i = 0; i < 5; i++) if (i !== 4) g.weight[2 * 5 + i] = 0 // a wall across row 2 with a gap at the right
  g.weight[0] = 0 // a corner nobody can stand in
  const goal = cellAt(g, 2 * FLOW.cell + 1, 1)
  const { cost, dir } = solveFlow(g, [goal])
  assert.deepEqual([dir[2 * goal], dir[2 * goal + 1]], [0, 0], 'the goal points nowhere')
  assert.deepEqual([dir[0], dir[1]], [0, 0], 'a wall points nowhere')
  assert.equal(cost[0], UNREACHED)
  // From the bottom-left, the route goes right along the bottom row to the gap, then up and left: never into the wall.
  const path = trace(g, dir, 0.5 * FLOW.cell, 4.5 * FLOW.cell)
  assert.ok(path.length > 3)
  for (const p of path) {
    const c = cellAt(g, p.x, p.z)
    assert.ok(c >= 0 && g.weight[c] !== 0, `the route stays on open cells: ${JSON.stringify(p)}`)
  }
  const end = path.at(-1)!
  assert.equal(cellAt(g, end.x, end.z), goal, 'the route ends at the goal')
  assert.ok(path.some((p) => cellAt(g, p.x, p.z) === cellAt(g, 4.5 * FLOW.cell, 2.5 * FLOW.cell)), 'through the gap')
  // A diagonal step has unit length in f32.
  for (let c = 0; c < dir.length; c += 2) {
    const len = Math.hypot(dir[c], dir[c + 1])
    assert.ok(len === 0 || Math.abs(len - 1) < 1e-6, `unit at ${c / 2}: ${len}`)
    if (dir[c] !== 0 && dir[c + 1] !== 0) assert.equal(Math.abs(dir[c]), DIAGONAL_UNIT)
  }
  assert.equal(NEIGHBOURS.length, 8)
  // flowAt is the shader's lookup: the cell under the point, zero outside.
  const p = path[0]
  const c = cellAt(g, p.x, p.z)
  assert.deepEqual(flowAt(g, dir, p.x, p.z), { x: dir[2 * c], z: dir[2 * c + 1] })
  assert.deepEqual(flowAt(g, dir, -1, -1), { x: 0, z: 0 })
})

test('in the city the route to someone behind a building goes round it, along the sidewalk rather than down the road', () => {
  const half = CITY.lotHalf
  const boxes: Box[] = []
  for (let k = 0; k < CITY.blocks; k++) {
    for (let m = 0; m < CITY.blocks; m++) {
      const cx = (k + 0.5) * CITY.pitch, cz = (m + 0.5) * CITY.pitch
      boxes.push([cx - half, 0, cz - half, cx + half, 20, cz + half])
    }
  }
  const g = cityGrid(boxes)
  // The operator on the sidewalk north of block (3, 3); the recruit on the sidewalk south of it: the lot is between.
  const lot = { x: 3.5 * CITY.pitch, z: 3.5 * CITY.pitch }
  const operator = { x: lot.x, z: 3 * CITY.pitch + CITY.roadHalf + 1 }
  const recruit = { x: lot.x, z: 4 * CITY.pitch - CITY.roadHalf - 1 }
  const t0 = performance.now()
  const { dir } = solveFlow(g, [nearestOpen(g, operator.x, operator.z)])
  const ms = performance.now() - t0
  const path = trace(g, dir, recruit.x, recruit.z)
  assert.ok(path.length > 5, 'a route exists')
  for (const p of path) {
    assert.ok(!(Math.abs(p.x - lot.x) < half && Math.abs(p.z - lot.z) < half), `never through the lot: ${JSON.stringify(p)}`)
  }
  const end = path.at(-1)!
  assert.equal(cellAt(g, end.x, end.z), nearestOpen(g, operator.x, operator.z))
  // The route runs along the lot's side on the sidewalk, not down the middle of the street.
  const onRoad = path.filter((p) => g.weight[cellAt(g, p.x, p.z)] === FLOW.roadWeight).length
  assert.ok(onRoad <= 4, `${onRoad} of ${path.length} steps on the road`)
  assert.ok(ms < 250, `the city solves in ${ms.toFixed(1)} ms`)
  // nearestOpen: a point inside the lot resolves to the sidewalk cell beside it; one far outside the grid to -1.
  const inside = nearestOpen(g, lot.x, lot.z, 1)
  assert.equal(inside, -1, 'the lot is wider than one cell')
  assert.ok(nearestOpen(g, lot.x, lot.z, 8) >= 0)
  assert.equal(nearestOpen(g, -100, -100, 2), 0, 'a point off the grid snaps to its nearest edge cell')
})

// ---------------------------------------------------------------- the shader, read

const uncomment = (s: string) => s.replace(/\/\/.*$/gm, '')

test('flowField.wgsl declares the reference\'s constants, neighbour order, bindings and workgroup size', () => {
  const src = uncomment(SOURCE)
  assert.equal(flowShader(), SOURCE)
  const constant = (name: string): string => {
    const m = src.match(new RegExp(`const ${name}: \\w+ = ([^;]+);`))
    assert.ok(m, name)
    return m![1]
  }
  assert.equal(Number(constant('UNREACHED')), UNREACHED)
  assert.equal(Number(constant('STRAIGHT')), FLOW.straight)
  assert.equal(Number(constant('DIAGONAL')), FLOW.diagonal)
  assert.equal(Math.fround(Number(constant('DIAGONAL_UNIT'))), DIAGONAL_UNIT)
  const di = src.match(/const DI = array<i32, 8>\(([^)]+)\)/)!, dj = src.match(/const DJ = array<i32, 8>\(([^)]+)\)/)!
  assert.deepEqual(di[1].split(',').map(Number), NEIGHBOURS.map((n) => n[0]))
  assert.deepEqual(dj[1].split(',').map(Number), NEIGHBOURS.map((n) => n[1]))
  assert.match(src, /let diagonal = k >= 4u;/, 'the four straight neighbours come first, then the diagonals')
  for (const [name, binding] of Object.entries(FLOW_BINDINGS)) {
    const m = src.match(new RegExp(`@group\\(0\\) @binding\\((\\d+)\\) var(?:<[^>]*>)? ${name}:`))
    assert.ok(m, `binding ${name}`)
    assert.equal(Number(m![1]), binding, name)
  }
  assert.match(src, /var flow: texture_storage_2d<rg32float, write>;/)
  for (const entry of ['relax', 'direction']) assert.match(src, new RegExp(`@compute @workgroup_size\\(${FLOW_WORKGROUP}\\)\\s*fn ${entry}\\(`))
  // The corner rule and the tie rule, as the reference has them.
  assert.match(src, /if \(diagonal && \(weight\[u32\(j \* w \+ ni\)\] == 0u \|\| weight\[u32\(nj \* w \+ i\)\] == 0u\)\) \{ return false; \}/)
  assert.match(src, /if \(n < best\) \{\s*best = n;/)
  assert.match(src, /if \(v < best\) \{ best = v; \}/)
})

// ---------------------------------------------------------------- the GPU wiring on a mock device

interface MockBuffer { label: string; size: number; usage: number; bytes: Uint8Array; mapped: boolean }
interface MockTexture { label: string; width: number; height: number; usage: number; bytes: Uint8Array }
type Entry = { binding: number; buffer?: MockBuffer; texture?: MockTexture }
interface Group { entryPoint: string; entries: Entry[] }

/**
 * A device whose dispatches run the reference passes on the mock buffers: `relax` is relaxStep over the bound cost
 * buffers (and counts into `changed`), `direction` is directions() into the bound texture. Maps resolve on flush().
 */
function mockDevice(grid: FlowGrid, opts: { validationError?: string } = {}) {
  const log: string[] = []
  const buffers: MockBuffer[] = []
  const textures: MockTexture[] = []
  const maps: (() => void)[] = []
  let shader = ''
  let dispatches = 0
  const device = {
    queue: {
      writeBuffer: (b: MockBuffer, offset: number, data: ArrayBufferView) => {
        assert.ok(b.usage & USAGE.COPY_DST, `${b.label}: not COPY_DST`)
        assert.ok(offset + data.byteLength <= b.size, `${b.label}: write out of bounds`)
        b.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset)
        log.push(`write ${b.label}`)
      },
      writeTexture: (dst: { texture: MockTexture }, data: ArrayBufferView, layout: { bytesPerRow: number }, size: { width: number; height: number }) => {
        assert.equal(layout.bytesPerRow, dst.texture.width * 8)
        assert.deepEqual(size, { width: dst.texture.width, height: dst.texture.height })
        dst.texture.bytes.set(new Uint8Array(data.buffer, data.byteOffset, dst.texture.bytes.length))
        log.push(`writeTexture ${dst.texture.label}`)
      },
      submit: (cmds: { ops: (() => void)[] }[]) => {
        log.push('submit')
        for (const c of cmds) for (const op of c.ops) op()
      },
    },
    createBuffer: (d: { label: string; size: number; usage: number }): MockBuffer => {
      const b = { label: d.label, size: d.size, usage: d.usage, bytes: new Uint8Array(d.size), mapped: false }
      buffers.push(b)
      return b
    },
    createTexture: (d: { label: string; size: { width: number; height: number }; format: string; usage: number }) => {
      assert.equal(d.format, 'rg32float')
      const t: MockTexture & { createView(): { texture: MockTexture } } = {
        label: d.label, width: d.size.width, height: d.size.height, usage: d.usage, bytes: new Uint8Array(d.size.width * d.size.height * 8),
        createView: () => ({ texture: t }),
      }
      textures.push(t)
      return t
    },
    createShaderModule: (d: { code: string }) => { shader = d.code; return {} },
    createComputePipeline: (d: { layout: string; compute: { entryPoint: string } }) => {
      assert.equal(d.layout, 'auto')
      return { entryPoint: d.compute.entryPoint, getBindGroupLayout: () => ({ entryPoint: d.compute.entryPoint }) }
    },
    createBindGroup: (d: { layout: { entryPoint: string }; entries: { binding: number; resource: { buffer?: MockBuffer; texture?: MockTexture } }[] }): Group => ({
      entryPoint: d.layout.entryPoint,
      entries: d.entries.map((e) => ({ binding: e.binding, buffer: e.resource.buffer, texture: e.resource.texture })),
    }),
    createCommandEncoder: () => {
      const ops: (() => void)[] = []
      return {
        beginComputePass: () => {
          let pipeline: { entryPoint: string } | null = null
          let group: Group | null = null
          return {
            setPipeline: (p: { entryPoint: string }) => { pipeline = p },
            setBindGroup: (i: number, g: Group) => { assert.equal(i, 0); assert.equal(g.entryPoint, pipeline!.entryPoint); group = g },
            dispatchWorkgroups: (n: number) => {
              const g = group!, ep = pipeline!.entryPoint
              assert.equal(n, Math.ceil(grid.width * grid.height / FLOW_WORKGROUP))
              ops.push(() => {
                dispatches++
                const at = (binding: number): Entry => g.entries.find((e) => e.binding === binding)!
                const costIn = new Int32Array(at(FLOW_BINDINGS.costIn).buffer!.bytes.buffer)
                if (ep === 'relax') {
                  const costOut = new Int32Array(at(FLOW_BINDINGS.costOut).buffer!.bytes.buffer)
                  const changed = new Uint32Array(at(FLOW_BINDINGS.changed).buffer!.bytes.buffer)
                  changed[0] += relaxStep(grid, costIn, costOut)
                  log.push('relax')
                } else {
                  assert.equal(ep, 'direction')
                  const tex = at(FLOW_BINDINGS.flow).texture!
                  assert.ok(tex.usage & TEXTURE_USAGE.STORAGE_BINDING)
                  directions(grid, costIn, new Float32Array(tex.bytes.buffer as ArrayBuffer))
                  log.push('direction')
                }
              })
            },
            end: () => {},
          }
        },
        copyBufferToBuffer: (src: MockBuffer, so: number, dst: MockBuffer, dof: number, size: number) => {
          assert.ok(src.usage & USAGE.COPY_SRC && dst.usage & USAGE.COPY_DST, 'copy usage')
          ops.push(() => { dst.bytes.set(src.bytes.subarray(so, so + size), dof); log.push('copy changed') })
        },
        finish: () => ({ ops }),
      }
    },
    pushErrorScope: () => {},
    popErrorScope: async () => (opts.validationError ? { message: opts.validationError } : null),
    flush: async () => {
      while (maps.length) maps.shift()!()
      await new Promise((r) => setImmediate(r))
    },
    log, buffers, textures, get shader() { return shader }, get dispatches() { return dispatches },
  }
  // mapAsync on the readback buffer resolves on flush, as the GPU's does later.
  const origCreate = device.createBuffer
  device.createBuffer = (d) => {
    const b = origCreate(d) as MockBuffer & { mapAsync(): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void }
    b.mapAsync = () => {
      assert.ok(b.usage & USAGE.MAP_READ, `${b.label} is not mappable`)
      assert.ok(!b.mapped, `${b.label} mapped twice`)
      return new Promise<void>((resolve) => maps.push(() => { b.mapped = true; resolve() }))
    }
    b.getMappedRange = () => { assert.ok(b.mapped); return b.bytes.slice().buffer }
    b.unmap = () => { b.mapped = false }
    return b
  }
  return device
}

test('the GPU solver: seeds, relaxes in batches of RELAX_BATCH ping-ponging two buffers, stops at the first batch that changed nothing, then writes the directions into the texture', async () => {
  const grid = maze(40, 30, 0.2, 7)
  const device = mockDevice(grid)
  const texture = createFlowTexture(device as unknown as GPUDevice, grid) as unknown as MockTexture & GPUTexture
  assert.equal(texture.width, 40)
  assert.equal(texture.usage & TEXTURE_USAGE.TEXTURE_BINDING, TEXTURE_USAGE.TEXTURE_BINDING)
  const solver = await FlowFieldGpu.create(device as unknown as GPUDevice, grid, texture)
  assert.equal(device.shader, flowShader())
  assert.equal(solver.passes, -1)
  const goals = [cellAt(grid, 1, 1)]
  const done = solver.solve(goals)
  assert.ok(solver.busy)
  // Each batch submits, then waits for its readback: flush until the solve resolves.
  let flushes = 0
  let settled = false
  void done.then(() => { settled = true })
  while (!settled) {
    await device.flush()
    flushes++
    assert.ok(flushes < 200, 'the solve resolves')
  }
  assert.ok(!solver.busy)
  const reference = solveByRelaxation(grid, goals)
  // The GPU made whole batches until one changed nothing: the reference's pass count rounded up to a batch.
  assert.equal(solver.passes, Math.ceil(reference.passes / RELAX_BATCH) * RELAX_BATCH)
  assert.ok(solver.passes <= relaxLimit(grid))
  const relaxes = device.log.filter((l) => l === 'relax').length
  assert.equal(relaxes, solver.passes)
  assert.equal(device.log.filter((l) => l === 'direction').length, 1)
  assert.ok(device.log.indexOf('direction') > device.log.lastIndexOf('relax'), 'the direction pass comes last')
  // The texture holds exactly the reference directions.
  const expected = directions(grid, reference.cost)
  assert.deepEqual(Array.from(new Float32Array(texture.bytes.buffer)), Array.from(expected))
  // The seed went into cost A, and the two cost buffers alternated: after an even number of passes the newest is in A.
  const a = device.buffers.find((b) => b.label === 'flow.costA')!
  const newest = solver.passes % 2 === 0 ? a : device.buffers.find((b) => b.label === 'flow.costB')!
  assert.deepEqual(Array.from(new Int32Array(newest.bytes.buffer)), Array.from(reference.cost))
})

test('the GPU solver: a goal asked while a solve runs is solved next (the newest once), and a validation error makes create reject', async () => {
  const grid = emptyGrid(16, 16)
  const device = mockDevice(grid)
  const texture = createFlowTexture(device as unknown as GPUDevice, grid) as unknown as MockTexture & GPUTexture
  const solver = await FlowFieldGpu.create(device as unknown as GPUDevice, grid, texture)
  const first = solver.solve([0])
  const second = solver.solve([5])
  const third = solver.solve([255])
  assert.equal(second, first, 'queued behind the running solve, resolved with it')
  assert.equal(third, first)
  let settled = 0
  void first.then(() => settled++)
  for (let i = 0; i < 100 && settled === 0; i++) await device.flush()
  assert.equal(settled, 1)
  // The queued goal (the newest) runs after: flush it through too.
  for (let i = 0; i < 100 && solver.busy; i++) await device.flush()
  assert.equal(device.log.filter((l) => l === 'direction').length, 2, 'two solves in all: the first and the newest queued goal')
  const expected = directions(grid, solveDial(grid, [255]))
  assert.deepEqual(Array.from(new Float32Array(texture.bytes.buffer)), Array.from(expected))

  const broken = mockDevice(grid, { validationError: 'no rg32float storage here' })
  await assert.rejects(FlowFieldGpu.create(broken as unknown as GPUDevice, grid, createFlowTexture(broken as unknown as GPUDevice, grid)), /validation failed: no rg32float/)
})

test('the CPU solver lands the same field in the texture with one writeTexture', async () => {
  const grid = maze(20, 12, 0.3, 3)
  const device = mockDevice(grid)
  const texture = createFlowTexture(device as unknown as GPUDevice, grid) as unknown as MockTexture & GPUTexture
  const solver = cpuFlowSolver(grid, (solution) => writeFlowTexture(device as unknown as GPUDevice, texture, grid, solution))
  await solver.solve([cellAt(grid, 1, 1)])
  assert.deepEqual(device.log, ['writeTexture crowd.flow'])
  assert.deepEqual(Array.from(new Float32Array(texture.bytes.buffer)), Array.from(solveFlow(grid, [cellAt(grid, 1, 1)]).dir))
  // No grid: a one-texel texture of zeros, so the shader's lookup finds no direction anywhere.
  const none = createFlowTexture(device as unknown as GPUDevice, null) as unknown as MockTexture
  assert.equal(none.width, 1)
  assert.equal(none.height, 1)
})
