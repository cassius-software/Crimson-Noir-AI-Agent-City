// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the depth and environment-probe wiring that removes the two stalls on screen: the
 * renderer asks three for a reversed (depth32float) depth buffer, so far streets and sidewalks stop fighting the ground;
 * the sky, which three's SkyMesh pins to z = w (the near plane under reversed depth), is pinned to the far plane
 * instead when the buffer is reversed; the crowd cull's frustum is cut with the camera's own coordinate system and
 * depth convention; and the world bakes its environment probe through EnvProbe into one reused render target, with the
 * scene's environment assigned only when the texture object changes (once). Nothing here needs a GPU; the renderer's
 * part is read from the source as the other wiring tests do.
 * What breaks if it is removed? A later edit could drop `reversedDepthBuffer`, pin the sky back to z = w under it
 * (sky painted over the city), cut the frustum with WebGL's planes, or allocate a probe target per bake again.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'

// Vite's `?raw` import, for Node (crowdCompute.test.ts's hook): world.ts's imports reach the crowd's WGSL that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { skyAtFarPlane } = await import('./world.ts')

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const world = read('./world.ts')
const engine = read('../07_Execute_Actions/engine.ts')

type N = { getChildren?: () => Iterable<unknown> }
/** Every node `root` reads from, itself included (ghost.test.ts's walk). */
const reach = (root: unknown): Set<N> => {
  const seen = new Set<N>()
  const walk = (n: unknown) => {
    if (Array.isArray(n)) { for (const c of n) walk(c); return }
    if (!n || typeof n !== 'object' || seen.has(n as N)) return
    seen.add(n as N)
    const node = n as N
    if (typeof node.getChildren === 'function') for (const c of node.getChildren()) walk(c)
    const raw = (node as { rawInputs?: unknown }).rawInputs
    if (raw) walk(raw)
  }
  walk(root)
  return seen
}

test('createRenderer asks for the reversed depth buffer (depth32float, near-even precision to the far plane)', () => {
  const ctor = world.slice(world.indexOf('new WebGPURenderer({'), world.indexOf('})', world.indexOf('new WebGPURenderer({')))
  assert.match(ctor, /reversedDepthBuffer: true/)
  // Every sky the world makes is told the renderer's convention.
  assert.match(world, /skyAtFarPlane\(s, renderer\.reversedDepthBuffer\)/)
})

test('under a conventional buffer the sky keeps SkyMesh\'s own vertex node (z = w is already the far plane)', () => {
  const sky = new SkyMesh()
  const own = sky.material.vertexNode
  assert.ok(own, 'SkyMesh has a vertex node of its own')
  skyAtFarPlane(sky, false)
  assert.equal(sky.material.vertexNode, own)
})

test('under the reversed buffer the sky\'s vertex node is wrapped, still computing SkyMesh\'s own, and writes no depth', () => {
  const sky = new SkyMesh()
  const own = sky.material.vertexNode
  skyAtFarPlane(sky, true)
  const wrapped = sky.material.vertexNode
  assert.ok(wrapped && wrapped !== own, 'a new vertex node')
  assert.ok(reach(wrapped).has(own as N), 'the wrapper reads SkyMesh\'s own node (its varyings must still be assigned)')
  assert.equal(sky.material.depthWrite, false, 'the sky still writes no depth: sky pixels keep the clear value')
  // The pin itself: clip z to 0, the far plane of a reversed [0, 1] buffer (the value it is cleared to).
  const body = world.slice(world.indexOf('export function skyAtFarPlane'), world.indexOf('\n}\n', world.indexOf('export function skyAtFarPlane')))
  assert.match(body, /p\.z\.assign\(float\(0\)\)/)
  assert.match(body, /if \(!reversedDepth\) return/)
})

test('the crowd cull cuts its frustum with the camera\'s coordinate system and depth convention, for every viewport', () => {
  const calls = engine.match(/setFromProjectionMatrix\([^)]*\)/g) ?? []
  assert.equal(calls.length, 2, 'player 1 and the split viewports')
  for (const c of calls) assert.match(c, /setFromProjectionMatrix\(\w+\.projScreen, cam\.coordinateSystem, cam\.reversedDepth\)/)
})

test('the environment probe bakes through EnvProbe into one reused target and points the scene at it once', () => {
  assert.match(world, /import \{ ENV_PROBE_STEP_HOURS, EnvProbe \} from '\.\/envProbe\.ts'/)
  // Every bake the same size (FULL_WORLD's 256, LITE_WORLD's 64), so the reused target always fits.
  assert.match(world, /pmrem\.fromScene\(envScene, 0\.02, 0\.1, 100, \{ renderTarget: reuse, size: probeSize \}\)/)
  assert.match(world, /const probeSize = detail\.probeSize\n/)
  assert.match(world, /if \(envProbe\.refresh\(hours\) && scene\.environment !== envProbe\.target!\.texture\) scene\.environment = envProbe\.target!\.texture/)
  // The sun is moved on the probe's sky before the bake that reads it.
  const update = world.slice(world.indexOf('const update = ('))
  assert.ok(update.indexOf('envSky.sunPosition.value.set(s.x, s.y, s.z)') < update.indexOf('envProbe.refresh(hours)'), 'sun set before the bake')
  // No other path to a fresh target or a per-bake dispose remains.
  assert.equal((world.match(/fromScene\(/g) ?? []).length, 1)
  assert.doesNotMatch(world, /envTarget\?\.dispose\(\)/)
})
