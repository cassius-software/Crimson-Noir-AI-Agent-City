// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the CPU shader host (wgslHost.ts) runs WGSL as the GPU does, on what the
 * crowd depends on: u32 and i32 arithmetic wrap and truncate, round() halves to even, conversions saturate,
 * vectors are copied and not shared, swizzles, select, switch and loops behave, atomics count, and struct layouts
 * follow the uniform rules; then that the shipped crowd.wgsl compiles whole, its Params struct lands where
 * packSimParams writes every block, its pure functions give the CPU's own answers (degreeOf, the walk window,
 * the First-Law corridor against vehicles.ts corridorDistance over random cars and people), and that CrowdHost
 * (crowdHost.ts) steps it as crowdSim.ts steps the GPU: the first reading lands at once, later ones after the
 * latency asked for, the hazard slots read the cars, frames are in the render layout, two hosts stepped alike
 * agree to the bit, and SimCore primes on it like on the GPU.
 * What breaks if it is removed? The soaks (crowdSoak.test.ts) could pass on a host that runs a different shader
 * from the one that ships, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { KERNEL, SIGNAL, walkAllowed } from '../02_Define_The_Rules/civic.ts'
import { createRng, degreeOf } from '../02_Define_The_Rules/degrees.ts'
import { compileWgsl, hostBuffer } from './wgslHost.ts'

// Vite's `?raw` import, for Node: the file as a default-exported string.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})

const {
  crowdShader, MAX_CARS, PARAMS_SIZE, PARAMS_STREETS, PARAMS_ROOMS, PARAMS_ROUTES, PARAMS_TRAIL, PARAMS_TRAIL_COUNT, SIM_PASSES, CULL_PASSES,
} = await import('./crowdCompute.ts')
const { ROOM_FLOATS } = await import('../01_Initialize_World/interiors.ts')
const { CAR, corridorDistance } = await import('../07_Execute_Actions/vehicles.ts')
const { CrowdHost } = await import('./crowdHost.ts')
const { SimCore } = await import('../07_Execute_Actions/simCore.ts')

const SMALL = `
struct S { a: vec4f, b: vec2f }
@group(0) @binding(0) var<storage, read_write> out: array<S>;
@group(0) @binding(1) var<storage, read_write> count: array<atomic<u32>>;
const K: u32 = 3u;
fn mul(a: u32, b: u32) -> u32 { return a * b; }
fn addu(a: u32, b: u32) -> u32 { return a + b; }
fn divi(a: i32, b: i32) -> i32 { return a / b; }
fn modi(a: i32, b: i32) -> i32 { return a % b; }
fn rnd(x: f32) -> f32 { return round(x); }
fn copyV(p: vec2f) -> f32 { var q = p; q.x = 5.0; return p.x + q.x; }
fn copyS(i: u32) -> f32 { var s = out[i]; s.a.y = 7.0; return out[i].a.y + s.a.y; }
fn swz(v: vec4f) -> vec2f { return v.zx; }
fn sel(c: bool) -> vec2f { return select(vec2f(1.0, 2.0), vec2f(3.0, 4.0), vec2<bool>(c, !c)); }
fn sw(k: u32) -> i32 { switch (k) { case 0u: { return 10; } case 1u, 2u: { return 20; } default: { return -1; } } }
fn bits(v: vec2f) -> vec2u { return bitcast<vec2u>(v); }
fn conv(x: f32) -> i32 { return i32(x); }
fn convu(x: f32) -> u32 { return u32(x); }
fn shr(x: u32, n: u32) -> u32 { return x >> n; }
fn shri(x: i32, n: u32) -> i32 { return x >> n; }
fn loopSum(n: u32) -> u32 { var s = 0u; for (var k = 0u; k < n; k++) { if (k == 2u) { continue; } s += k; } return s; }
fn vecMath(a: vec2f, s: f32) -> vec2f { return (a * s - 1.0) / vec2f(2.0, 4.0) + f32(K); }
fn cmp(a: vec2i, b: vec2i) -> bool { return any(a < b) && !all(a == b); }
fn f32Round(x: f32) -> f32 { return x * 3.0; }
fn arr(w: u32) -> f32 { let ways = array<f32, 3>(1.5, 2.5, 3.5); return ways[w]; }
@compute @workgroup_size(4)
fn fill(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  out[i].a = vec4f(f32(i), 1.0, 2.0, 3.0);
  out[i].b = vec2f(f32(i) * 0.5);
  atomicAdd(&count[0], 1u);
  atomicMin(&count[1], i);
}
`

test('compileWgsl: integer wrap and truncation, round half to even, saturating conversions, copies, swizzles, select, switch, loops, atomics', () => {
  const m = compileWgsl(SMALL)
  assert.deepEqual(m.entries, { fill: 4 })
  assert.equal(m.call('mul', 0xffffffff, 2), 0xfffffffe)
  assert.equal(m.call('mul', 747796405, 3), (747796405 * 3) % 2 ** 32)
  assert.equal(m.call('addu', 0xffffffff, 1), 0)
  assert.equal(m.call('divi', -7, 2), -3)
  assert.equal(m.call('divi', 7, -2), -3)
  assert.equal(m.call('modi', -7, 2), -1)
  assert.deepEqual([2.5, 3.5, -2.5, -3.5, 0.5, 1.5].map((x) => m.call('rnd', x)), [2, 4, -2, -4, 0, 2])
  assert.equal(m.call('copyV', [1, 2]), 6)
  assert.deepEqual(m.call('swz', [1, 2, 3, 4]), [3, 1])
  assert.deepEqual(m.call('sel', true), [3, 2])
  assert.deepEqual(m.call('sel', false), [1, 4])
  assert.deepEqual([0, 1, 2, 9].map((k) => m.call('sw', k)), [10, 20, 20, -1])
  assert.deepEqual(m.call('bits', [1, -0]), [0x3f800000, 0x80000000])
  assert.deepEqual([-3.7, NaN, 1e10, -1e10].map((x) => m.call('conv', x)), [-3, 0, 2147483647, -2147483648])
  assert.deepEqual([-1, 3.9, 1e10].map((x) => m.call('convu', x)), [0, 3, 4294967295])
  assert.equal(m.call('shr', 0x80000000, 31), 1)
  assert.equal(m.call('shri', -8, 1), -4)
  assert.equal(m.call('loopSum', 5), 8)
  assert.deepEqual(m.call('vecMath', [2, 4], 1.5), [Math.fround((2 * 1.5 - 1) / 2 + 3), Math.fround((4 * 1.5 - 1) / 4 + 3)])
  assert.equal(m.call('cmp', [1, 5], [2, 5]), true)
  assert.equal(m.call('cmp', [2, 5], [2, 5]), false)
  // Every float operation is rounded to f32 as the GPU rounds it.
  assert.equal(m.call('f32Round', 0.1), Math.fround(Math.fround(0.1) * 3))
  assert.equal(m.call('arr', 1), 2.5)
  assert.deepEqual(m.layout('S'), { size: 32, align: 16, members: [{ name: 'a', offset: 0, type: 'vec4<f32>' }, { name: 'b', offset: 16, type: 'vec2<f32>' }] })
  const out = hostBuffer(8 * 32), count = hostBuffer(8)
  count.u[1] = 0xffffffff
  m.bind('out', out)
  m.bind('count', count)
  m.dispatch('fill', 2)
  assert.deepEqual([...out.f.subarray(7 * 8, 7 * 8 + 6)], [7, 1, 2, 3, 3.5, 3.5])
  assert.deepEqual([...count.u], [8, 0])
  // A struct read from a buffer is a copy: writing the copy leaves the buffer alone.
  assert.equal(m.call('copyS', 3), 1 + 7)
  assert.equal(out.f[3 * 8 + 1], 1)
  assert.throws(() => m.dispatch('nope', 1), /no entry point/)
  assert.throws(() => compileWgsl('fn f() -> f32 { return g(); }'), /unknown function g/)
})

test('crowd.wgsl compiles whole: the entry points are the passes at their workgroup sizes, and Params lands where packSimParams writes', () => {
  const m = compileWgsl(crowdShader(256))
  assert.deepEqual(Object.keys(m.entries).sort(), [...SIM_PASSES, ...CULL_PASSES].sort())
  assert.deepEqual(m.entries, { clearGrid: 256, binAgents: 128, spawn: 128, simulate: 128, cull: 128 })
  const p = m.layout('Params')
  const at = (name: string) => p.members.find((x) => x.name === name)!.offset
  assert.equal(p.size, PARAMS_SIZE)
  assert.equal(at('cars'), 192)
  assert.equal(at('summons'), 192 + MAX_CARS * 32)
  assert.equal(at('streets'), PARAMS_STREETS)
  assert.equal(at('rooms'), PARAMS_ROOMS)
  assert.equal(at('routes'), PARAMS_ROUTES)
  assert.equal(at('trail'), PARAMS_TRAIL)
  assert.equal(at('trailCount'), PARAMS_TRAIL_COUNT)
  assert.equal(m.layout('Car').size, 32)
  assert.equal(m.layout('Summon').size, 16)
  assert.equal(m.layout('Brain').size, 64)
  assert.equal(m.layout('Room').size, ROOM_FLOATS * 4)
})

test('the compiled shader\'s pure functions give the CPU\'s answers: degreeOf, the walk window, the First-Law corridor', () => {
  const m = compileWgsl(crowdShader(256))
  for (let dc = 0; dc <= 40; dc += 2) {
    for (let mod = -10; mod <= 25; mod += 3) {
      for (let n = 1; n <= 20; n++) assert.equal(m.call('degreeOf', n, n + mod, dc), degreeOf(n, n + mod, dc), `n=${n} mod=${mod} dc=${dc}`)
    }
  }
  for (let t = 0; t < 2 * SIGNAL.cycle; t += 0.125) {
    assert.equal((m.call('walkElapsed', true, t) as number) >= 0, walkAllowed('ew', t), `ew t=${t}`)
    assert.equal((m.call('walkElapsed', false, t) as number) >= 0, walkAllowed('ns', t), `ns t=${t}`)
  }
  // corridorGap in the car's frame, driving on and reversing, against vehicles.ts corridorDistance (f64). The host
  // computes in f32, so a contact may differ by millimetres; the range edge and a contact the footprint has only
  // just left (the shader's hair rule) are the other two places the two may read differently.
  const axle = CAR.wheelbase / 2
  const fullLock = Math.tan(CAR.maxSteer) / CAR.wheelbase
  const rng = createRng(777)
  let agreed = 0, contacts = 0, apart = 0
  for (let n = 0; n < 12000; n++) {
    const kind = rng()
    const curvature = kind < 0.1 ? 0 : kind < 0.3 ? (rng() - 0.5) * 2e-3 : (rng() * 2 - 1) * fullLock
    const heading = (rng() * 2 - 1) * Math.PI
    const cx = rng() * 480, cz = rng() * 480
    const px = cx + (rng() * 2 - 1) * 12, pz = cz + (rng() * 2 - 1) * 12
    const dir = n % 2 ? -1 : 1
    const fx = Math.sin(heading), fz = Math.cos(heading)
    const dx = px - cx, dz = pz - cz
    const lz = dx * fx + dz * fz, lx = dx * -fz + dz * fx
    const raw = m.call('corridorGap', dir > 0 ? lz : -lz, -lx, CAR.halfWidth, CAR.halfLength, curvature, dir > 0 ? -axle : axle) as number
    const gpu = raw < 0 ? Infinity : raw
    const cpu = corridorDistance(px, pz, cx, cz, heading, curvature, dir)
    if (cpu === gpu || Math.abs(cpu - gpu) < 5e-3) { agreed++; if (cpu !== Infinity) contacts++; continue }
    const edge = (Math.min(cpu, gpu) > KERNEL.range - 0.05) || (Math.min(cpu, gpu) === 0 && Math.max(cpu, gpu) < 0.05)
    assert.ok(edge || Math.abs(cpu - gpu) < 0.05, `car (${cx}, ${cz}) heading ${heading} k ${curvature} person (${px}, ${pz}) dir ${dir}: cpu ${cpu} host ${gpu}`)
    apart++
  }
  assert.ok(contacts > 1000 && apart < 24, `${contacts} contacts of ${agreed} agreed, ${apart} apart`)
})

const input = (seq: number, dt: number, time: number, cars: { x: number; z: number; heading: number; speed: number }[] = []) => ({
  seq, dt, time, player: { x: 0, z: 0, heading: 0, speed: 0, visible: false },
  cars: cars.map((c) => ({ ...c, halfWidth: CAR.halfWidth, halfLength: CAR.halfLength, curvature: 0 })), summons: [],
})

test('CrowdHost steps crowd.wgsl as crowdSim.ts does: the first reading at once, later ones after the latency; the hazards read the cars; frames in the render layout', () => {
  const host = new CrowdHost(256, null, null, null, { latency: 2 })
  // (Compared as booleans: an assertion on the property itself would narrow its type for the rest of the test.)
  assert.equal(host.readout === null, true)
  assert.equal(host.lost === null, true)
  // Pedestrian 1 put down on a sidewalk lane, a car 8 m behind it on the road facing it: the car senses it 8 − halfLength ahead.
  host.place(1, 100, 125.8, 0)
  host.step(input(1, 1 / 60, 1 / 60, [{ x: 100, z: 117.8, heading: 0, speed: 0 }]))
  const r = host.readout
  assert.ok(r !== null && r.seq === 1)
  assert.ok(Math.abs(r.hazardsAhead[0] - (8 - CAR.halfLength)) < 0.02, `ahead ${r.hazardsAhead[0]}`)
  assert.equal(r.hazardsBehind[0], Infinity)
  assert.equal(r.hazardsAhead[1], Infinity)
  // The positions read back are the step's end (the GPU's readback copies the buffers after simulate), a step's walk on.
  assert.ok(Math.abs(r.xz[2] - 100) < 0.1 && Math.abs(r.xz[3] - 125.8) < 0.1, `xz ${r.xz[2]}, ${r.xz[3]}`)
  // The reading is stamped with the start of the substep it measured.
  assert.ok(Math.abs(r.time) < 1e-9)
  // Latency 2: the reading of step n lands with step n + 2.
  for (let n = 2; n <= 4; n++) host.step(input(n, 1 / 60, n / 60))
  assert.equal(host.readout!.seq, 2)
  host.step(input(5, 1 / 60, 5 / 60))
  assert.equal(host.readout!.seq, 3)
  const frame = host.takeFrame()
  assert.ok(frame !== null && frame.length === 256 * 12)
  assert.equal(host.takeFrame(), null)
  assert.equal(frame[4], host.readout!.xz[2])
  // A long step is taken in substeps of at most CROWD_SUBSTEP, and the reading is the last substep's.
  host.step(input(6, 0.1, 0.2))
  host.step(input(7, 1 / 60, 0.2 + 1 / 60))
  host.step(input(8, 1 / 60, 0.2 + 2 / 60))
  assert.ok(Math.abs(host.readout!.time - (0.2 - 0.05)) < 1e-6)
  // Everyone is finite and on the ground, and the realm's own copy agrees with the buffers.
  const s = host.state
  for (let i = 0; i < 256; i++) {
    assert.ok(Number.isFinite(s.pos[4 * i]) && Number.isFinite(s.pos[4 * i + 2]), `agent ${i}`)
    assert.equal(s.pos[4 * i + 1], i === 0 ? -100 : 0)
  }
})

test('two hosts stepped alike agree to the bit, and a host inside the realm primes SimCore like the GPU', async () => {
  const a = new CrowdHost(256), b = new CrowdHost(256)
  for (let n = 1; n <= 40; n++) {
    const cars = [{ x: 200 + n * 0.2, z: 205.8, heading: Math.PI / 2, speed: 12 }]
    a.step(input(n, 1 / 60, n / 60, cars))
    b.step(input(n, 1 / 60, n / 60, cars))
  }
  assert.deepEqual([...a.state.pos], [...b.state.pos])
  assert.deepEqual([...a.state.brain], [...b.state.brain])
  assert.ok(a.readout!.stats.crossing + a.readout!.stats.waiting >= 0)
  let host: InstanceType<typeof CrowdHost> | null = null
  const core = await SimCore.create(
    { seed: 11, cars: 2, agents: 256, boxes: [], furniture: { lamps: [], trees: [], signals: [] }, spawn: { x: -600, z: 0 }, debug: false },
    async (agents, grid, streets, rooms) => (host = new CrowdHost(agents, grid, streets, rooms)),
  )
  assert.ok(host !== null && (host as InstanceType<typeof CrowdHost>).readout !== null)
  const poses = new Float32Array(2 * 28)
  let st = core.step({ dt: 1 / 60, foot: { x: 0, z: 0, heading: NaN }, drive: { steer: 0, fwd: 0, back: 0, handbrake: false }, cmds: [] }, poses)
  for (let n = 0; n < 10; n++) st = core.step({ dt: 1 / 60, foot: { x: 0, z: 0, heading: NaN }, drive: { steer: 0, fwd: 0, back: 0, handbrake: false }, cmds: [] }, poses)
  assert.equal(core.halted, false)
  assert.ok(st.crowd.ageMs !== null && st.crowd.ageMs >= 0 && st.crowd.ageMs < 100)
  assert.ok(st.crowdFrame instanceof Float32Array)
})
