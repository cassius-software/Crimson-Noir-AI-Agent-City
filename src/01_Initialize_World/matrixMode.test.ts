// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Matrix mode has no GPU oracle under Node, so what can be pinned is pinned: the global
 * state's layout and packer (the one word both pipelines read), the floating origin's snap and bounds, the physics
 * mask and its layers (the CPU twin of crowd.wgsl physicsMaskFor), the WGSL surface's shape (the three triplanar
 * planes, the camera-relative grid, the early return with the mode off, the shared uniform read as the shaders of
 * both pipelines read it) and the material graph applyMatrixMode builds (colour dimmed by the surface's alpha, the
 * glow into the emissive, nothing else touched). The crowd's own binding of the same word is crowdCompute.test.ts's.
 * What breaks if it is removed? The two pipelines could drift apart in what the word means, and a mode that stopped
 * reaching a material would only show in the browser.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu'
import { normalWorldGeometry, positionWorld, vec3 } from 'three/tsl'
import { GLOBAL_STATE_FLOATS, MATRIX_MODE, PHYSICS_LAYER, PHYSICS_MASK, floatingOrigin, packGlobalState, physicsMaskFor } from './globalState.ts'

// Vite's `?raw` import, for Node (crowdCompute.test.ts's hook): matrixMode.ts imports its WGSL that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { applyMatrixMode, createMatrixMode } = await import('./matrixMode.ts')

const SOURCE = readFileSync(new URL('./matrixMesh.wgsl', import.meta.url), 'utf8')
const CROWD = readFileSync(new URL('../03_Spawn_Agents/crowd.wgsl', import.meta.url), 'utf8')
const uncomment = (s: string) => s.replace(/\/\/.*$/gm, '')

// ---------------------------------------------------------------- the global state

test('packGlobalState: x = time, y = mode, z and w = the origin, at the offset asked; absent or non-finite is zero', () => {
  const f = new Float32Array(12).fill(9)
  packGlobalState(f, 4, { time: 12.5, on: true, originX: -7, originZ: 1024 })
  assert.deepEqual([...f.subarray(4, 8)], [12.5, 1, -7, 1024])
  assert.ok([...f.subarray(0, 4), ...f.subarray(8)].every((x) => x === 9), 'nothing outside the word is written')
  packGlobalState(f, 0, { time: Number.NaN, on: false, originX: Infinity, originZ: -Infinity })
  assert.deepEqual([...f.subarray(0, 4)], [0, 0, 0, 0])
  packGlobalState(f, 8, undefined)
  assert.deepEqual([...f.subarray(8, 12)], [0, 0, 0, 0])
  assert.equal(GLOBAL_STATE_FLOATS, 4)
})

test('floatingOrigin: the camera snapped down to whole metres, held inside the f32-exact range, 0 for a non-finite camera', () => {
  assert.deepEqual(floatingOrigin(123.7, -0.2), { x: 123, z: -1 })
  assert.deepEqual(floatingOrigin(0, 0), { x: 0, z: 0 })
  assert.deepEqual(floatingOrigin(Number.NaN, Infinity), { x: 0, z: 0 })
  assert.deepEqual(floatingOrigin(-1e9, 1e9), { x: -MATRIX_MODE.originLimit, z: MATRIX_MODE.originLimit })
  // The shaders add origin × 10 back as a whole number: every origin inside the limit keeps that exact in f32.
  assert.ok(MATRIX_MODE.originLimit * 10 < 2 ** 24)
  assert.equal(MATRIX_MODE.originSnap % 0.1 < 1e-9 || Math.abs((MATRIX_MODE.originSnap / 0.1) % 1) < 1e-9, true, 'a whole number of 0.1 m cells')
})

test('the physics mask: every layer off the mode, the static world alone in it; the layers are distinct bits', () => {
  assert.equal(physicsMaskFor(false), PHYSICS_MASK.all)
  assert.equal(physicsMaskFor(true), PHYSICS_MASK.matrix)
  assert.equal(PHYSICS_MASK.matrix, 0x00000001)
  assert.equal(PHYSICS_MASK.all, 0xffffffff)
  const bits = Object.values(PHYSICS_LAYER)
  assert.deepEqual(bits, [1, 2, 4])
  assert.equal(PHYSICS_LAYER.world & PHYSICS_MASK.matrix, PHYSICS_LAYER.world, 'grounded: the static world stays')
  assert.equal(PHYSICS_LAYER.body & PHYSICS_MASK.matrix, 0, 'people phase through people')
  assert.equal(PHYSICS_LAYER.vehicle & PHYSICS_MASK.matrix, 0, 'cars phase through people')
})

test('createMatrixMode: the uniform and the state follow set(); the origin is the snapped camera', () => {
  const m = createMatrixMode()
  assert.equal(m.on, false)
  assert.deepEqual([...m.globalState.value.toArray()], [0, 0, 0, 0])
  m.set(3.5, true, 10.9, -2.1)
  assert.equal(m.on, true)
  assert.deepEqual(m.state, { time: 3.5, on: true, originX: 10, originZ: -3 })
  assert.deepEqual([...m.globalState.value.toArray()], [3.5, 1, 10, -3])
  m.set(Number.NaN, false, 0, 0)
  assert.deepEqual([...m.globalState.value.toArray()], [0, 0, 0, 0])
})

// ---------------------------------------------------------------- the WGSL surface

test('matrixMesh.wgsl: one surface function over the shared word, triplanar by the normal, camera-relative, off below 0.5', () => {
  const code = uncomment(SOURCE)
  assert.match(code, /fn matrixSurface\(world_position: vec3<f32>, normal: vec3<f32>, base_color: vec3<f32>, global_state: vec4<f32>\) -> vec4<f32>/)
  assert.match(code, /fn matrixRandom\(st: vec2<f32>\) -> f32/)
  assert.ok(code.includes('if (global_state.y < 0.5) { return vec4<f32>(base_color, 0.0); }'), 'off: the base colour, alpha 0')
  assert.ok(code.includes('let time = global_state.x * 1.5;'))
  assert.ok(code.includes('let origin = global_state.zw;'))
  // The three planes, chosen by the dominant axis of the normal.
  assert.ok(code.includes('if (abs(normal.y) > 0.5) {'))
  assert.ok(code.includes('rain_uv = vec2<f32>(world_position.x, world_position.z);'))
  assert.ok(code.includes('} else if (abs(normal.x) > 0.5) {'))
  assert.ok(code.includes('rain_uv = vec2<f32>(world_position.z, world_position.y);'))
  assert.ok(code.includes('rain_uv = vec2<f32>(world_position.x, world_position.y);'))
  // The grid is computed relative to the origin and the id gets the origin back, times ten, as a whole number.
  assert.ok(code.includes('let grid_uv = (rain_uv - origin_uv) * 10.0;'))
  assert.ok(code.includes('let id = floor(grid_uv) + origin_uv * 10.0;'))
  assert.ok(code.includes('let matrix_color = vec3<f32>(0.05, 0.8, 0.15) * glow;'))
  assert.ok(code.includes('return vec4<f32>(final_color + (base_color * 0.1), 1.0);'))
  // No bind group of its own: the host supplies every input (three's pipeline binds the uniform).
  assert.doesNotMatch(code, /@group|@binding|@fragment|@vertex|textureSample/)
})

test('both pipelines read the one word the same way: y is the mode in the surface and in crowd.wgsl physicsMaskFor', () => {
  const crowd = uncomment(CROWD)
  assert.ok(crowd.includes('global: vec4f,'), 'Params carries the word')
  assert.ok(crowd.includes('if (global_state.y > 0.5) { physics_mask = 0x00000001u; } else { physics_mask = 0xFFFFFFFFu; }'))
  assert.ok(crowd.includes('let physicsMask = physicsMaskFor(P.global);'))
  assert.ok(uncomment(SOURCE).includes('if (global_state.y < 0.5) { return vec4<f32>(base_color, 0.0); }'))
  // The mask gates the contacts: the neighbours (body layer) and the cars' push and save (vehicle layer).
  assert.ok(crowd.includes('let bodies = layerOn(physicsMask, PHYSICS_BODY);'))
  assert.ok(crowd.includes('let vehicles = layerOn(physicsMask, PHYSICS_VEHICLE);'))
  assert.ok(crowd.includes('if (d2 < SEP_R2) { sep += d / d2 * bodies; }'))
  assert.ok(crowd.includes('let hw = (car.b.x + BODY_PAD) * vehicles;'))
  assert.ok(crowd.includes('} else if (road && vehicles > 0.5 &&'))
  // Grounded in every mode: the written position's y is 0, and the lot and city containment take no mask.
  assert.ok(crowd.includes('pos[i] = vec4f(me.x, 0.0, me.y, p.w);'))
  assert.ok(crowd.includes('let held = contain(me, next, 0.35, mayEnter || asked);') && crowd.includes('me = clampCity(held);'))
  // The First-Law sensing is not gated: a car still sees whoever is in its path.
  assert.ok(crowd.includes('if (ahead >= 0.0) { atomicMin(&hazards[j], u32(ahead * 100.0)); }'))
})

// ---------------------------------------------------------------- the material graph

/** Every node reachable from `n` (three's node graph: children by their property names, a call's by its parameters). */
function nodes(n: unknown): Set<object> {
  const out = new Set<object>()
  const visit = (x: unknown) => {
    if (typeof x !== 'object' || x === null || out.has(x)) return
    out.add(x)
    if (Array.isArray(x)) { for (const e of x) visit(e); return }
    const o = x as Record<string, unknown>
    if (!('isNode' in o)) { for (const v of Object.values(o)) if (typeof v === 'object' && v !== null && 'isNode' in v) visit(v); return }
    for (const [k, v] of Object.entries(o)) if (!k.startsWith('_') && k !== 'parent') visit(v)
  }
  visit(n)
  return out
}
/** The WGSL surface's call in `n`'s graph: its parameters by name. */
function surfaceCall(n: unknown): Record<string, unknown> {
  const call = [...nodes(n)].find((x) => x.constructor.name === 'FunctionCallNode') as { parameters: Record<string, unknown> } | undefined
  assert.ok(call, 'calls the WGSL surface')
  return call.parameters
}

test('applyMatrixMode: colour dimmed by the surface alpha, the glow added to the emissive, the uniform in both, the rest untouched', () => {
  const m = createMatrixMode()
  const material = new MeshStandardNodeMaterial()
  material.colorNode = vec3(0.2, 0.3, 0.4)
  material.emissiveNode = vec3(1, 0, 0)
  material.roughnessNode = vec3(0.5).x
  const before = { roughness: material.roughnessNode, position: material.positionNode, normal: material.normalNode, mask: material.maskNode }
  const same = applyMatrixMode(material, m.globalState)
  assert.equal(same, material)
  assert.ok(material.colorNode !== null && material.emissiveNode !== null)
  for (const node of [material.colorNode, material.emissiveNode]) {
    assert.ok(nodes(node).has(m.globalState as unknown as object), 'reads the shared uniform')
    // Positional, in the shader's order: world_position, normal, base_color, global_state.
    const p = surfaceCall(node)
    assert.deepEqual(Object.keys(p), ['0', '1', '2', '3'])
    assert.equal(p[0], positionWorld)
    assert.equal(p[1], normalWorldGeometry)
    assert.equal(p[3], m.globalState, 'the one uniform, where the shader reads global_state')
  }
  assert.equal(material.roughnessNode, before.roughness)
  assert.equal(material.positionNode, before.position)
  assert.equal(material.normalNode, before.normal)
  assert.equal(material.maskNode, before.mask)
  // Without an emissive of its own the material's emissive is the glow alone.
  const plain = applyMatrixMode(new MeshStandardNodeMaterial(), m.globalState)
  assert.ok(plain.emissiveNode !== null)
  assert.ok(nodes(plain.emissiveNode as Node).has(m.globalState as unknown as object))
})
