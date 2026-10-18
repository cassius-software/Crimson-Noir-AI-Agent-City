// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side wiring of the lite profile (governor.ts DeviceProfile.lite), which
 * the engine, the world and the host carry and Node cannot boot: ?lite, ?quality=-1|lite and an absent ?cars read by
 * the host; the profile, the crowd and the fleet decided in Engine.create; the post chain capped off and left out of
 * the boot draw; the lighter world (no lamp lights, a small probe baked less often, no clouds, coarser furniture, a
 * lazier building sort); the physics realm given no furniture sensors, no ragdoll and no scheduled craft; the rig
 * meshes left out when there are no rig slots; and the ghost view's refusal naming the profile. It also holds the
 * non-lite boot to what it was: FULL_WORLD is the authored city, and an uncapped boot still draws both paths.
 * What breaks if it is removed? A later edit could compile the post chain on the weakest phones again, hand the realm
 * thousands of sensors it never queries, or change the boot of every other device while touching the lite one.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BufferGeometry, CylinderGeometry, IcosahedronGeometry, SphereGeometry, BoxGeometry } from 'three/webgpu'

// Vite's `?raw` import, for Node (crowdCompute.test.ts's hook): world.ts and rigView.ts reach the crowd's WGSL that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { FULL_WORLD, LITE_WORLD } = await import('../01_Initialize_World/world.ts')
const { RigView } = await import('./rigView.ts')
const { streetFurniture } = await import('../01_Initialize_World/city.ts')
const { ENV_PROBE_STEP_HOURS } = await import('../01_Initialize_World/envProbe.ts')
const { RIG_POSE } = await import('./simProtocol.ts')

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, `missing ${from} … ${to}`)
  return src.slice(a, b)
}
const APP = read('../App.tsx')
const ENGINE = read('./engine.ts')
const WORLD = read('../01_Initialize_World/world.ts')
const CREATE = between(ENGINE, '  static async create(', '  /** The minimap')

test('host: ?lite=1 and ?lite=0 reach the engine, ?quality takes -1 and the word lite, and an absent ?cars is left to the profile', () => {
  const opts = between(APP, 'function readOptions(): Options {', '\n}\n')
  assert.match(opts, /lite: q\.get\('lite'\) === '1' \? true : q\.get\('lite'\) === '0' \? false : undefined,/)
  assert.match(opts, /cars: q\.has\('cars'\) \? Math\.round\(num\('cars', 36, 0, 48\)\) : undefined,/, 'the same clamp when given')
  assert.match(opts, /quality === 'lite' \? -1 : Math\.round\(num\('quality', 3, -1, 4\)\)/)
  assert.match(opts, /agents: q\.has\('crowd'\) \? Math\.round\(num\('crowd', 14000, 256, 60000\)\) : undefined,/, '?crowd still wins')
  assert.match(ENGINE, /^ {2}lite\?: boolean$/m, 'EngineOptions.lite')
  assert.match(ENGINE, /^ {2}cars\?: number$/m, 'EngineOptions.cars')
})

test('engine: the profile takes ?lite, and decides the crowd and the fleet unless the page said; a region still caps the fleet', () => {
  assert.match(CREATE, /const profile = profileDevice\(hints, requested\.lite\)\n\s+const lite = profile\.lite/)
  assert.match(CREATE, /const cars = requested\.cars \?\? defaultCars\(profile\)/)
  assert.match(CREATE, /Math\.min\(cars, streetCapacity\(streets, requested\.seed\)\)\) : cars,/)
  assert.match(CREATE, /agents: empty \? AGENTS_RANGE\[0\] : requested\.agents \?\? defaultAgents\(profile\)/)
  // The governor carries the flag to the console and the snapshot (QualityState.lite).
  assert.match(CREATE, /new Governor\(\{ tier: profile\.startTier, auto: true, targetMs, pacerMs, lite, \.\.\.range \}\)/)
  assert.match(CREATE, /new Governor\(\{ tier: options\.quality, auto: false, targetMs, pacerMs, lite, \.\.\.range \}\)/)
})

test('engine: a lite profile caps the post chain off as ?post=0 does, and no capped boot draws (compiles) the chain', () => {
  assert.match(CREATE, /post: requested\.post && players === 1 && !lite, lite,/)
  // The mask and the ghost view's forcing read options.post: a capped chain never runs at any tier.
  assert.match(CREATE, /post: k\.post && options\.post \}\)/)
  assert.match(ENGINE, /if \(this\.ghost\.on && this\.options\.post\) k\.post = true/)
  const scope = between(CREATE, "gpu.device.pushErrorScope('validation')", 'const invalid = await gpu.device.popErrorScope()')
  assert.match(scope, /gpu\.renderer\.render\(world\.scene, world\.camera\)\n\s+if \(options\.post\) post\.render\(\)/, 'uncapped: both paths, as before')
  // The ghost view's refusal says why.
  const ghost = between(ENGINE, '  setGhost(on: boolean): string {', '\n  }\n')
  assert.match(ghost, /if \(on && !this\.options\.post && this\.options\.lite\) return 'needs the post-processing chain, which the lite profile turned off \(\?lite=0 keeps it\)'/)
  assert.ok(ghost.indexOf('this.options.lite') < ghost.indexOf("which ?post=0 turned off'"), 'the lite reason first')
})

test('engine: the lite boot builds the lighter world and hands the realm no furniture sensors, no ragdoll and no craft', () => {
  assert.match(CREATE, /buildWorld\(gpu\.renderer, options\.seed, pack && layout && hollow \? \{ pack: hollow\.pack, layout: \{ \.\.\.layout, floors: hollow\.floors \}, streets, plan: hollow\.plan \} : null, lite \? LITE_WORLD : FULL_WORLD\)/)
  const sim = between(CREATE, 'simBoot = SimClient.create({', '})')
  assert.match(sim, /furniture: lite \? NO_FURNITURE : world\.furniture/)
  assert.match(sim, /ragdoll: options\.ragdoll !== false && !pack && !lite, craft: !lite,/)
  assert.match(ENGINE, /const NO_FURNITURE = Object\.freeze\(\{ lamps: \[\], trees: \[\], signals: \[\] \}\)/)
  // The page keeps its own furniture for drawing, the pole index, the contact pulse, the dissolve and the ghost view.
  assert.match(CREATE, /createGhost\(\{ boxes: world\.boxes, furniture: world\.furniture,/)
  assert.match(ENGINE, /new DissolveSet\(\{ lamps: f\.lamps\.length, trees: f\.trees\.length, signals: f\.signals\.length,/)
  // Without rig slots the rig meshes stay out of the scene and the ghost view.
  assert.match(CREATE, /const rigMeshes = sim\.meta\.rigSlots > 0 \? rigView\.meshes : \[\]/)
  assert.match(CREATE, /world\.scene\.add\(\.\.\.view0\.meshes, \.\.\.view\.bodies, view\.wheels, \.\.\.rigMeshes\)/)
  assert.match(CREATE, /rigs: rigMeshes \}\)/)
  // The realm's host passes the craft flag on, defaulting to on.
  assert.match(read('./simHost.ts'), /craft: init\.craft !== false,/)
})

test('world: FULL_WORLD is the city as authored; LITE_WORLD drops the lamp lights, shrinks and slows the probe, clears the sky', () => {
  assert.deepEqual({ ...FULL_WORLD }, { lampLights: 6, probeSize: 256, probeStepHours: ENV_PROBE_STEP_HOURS, cloudCoverage: 0.32, canopyDetail: 1, lensSegments: [10, 6], resortMetres: 6 })
  assert.equal(ENV_PROBE_STEP_HOURS, 0.2)
  assert.deepEqual({ ...LITE_WORLD }, { lampLights: 0, probeSize: 64, probeStepHours: 1, cloudCoverage: 0, canopyDetail: 0, lensSegments: [6, 4], resortMetres: 24 })
  assert.ok(Object.isFrozen(FULL_WORLD) && Object.isFrozen(LITE_WORLD))
  assert.match(WORLD, /detail: Readonly<WorldDetail> = FULL_WORLD\): World \{/, 'every other caller keeps the authored city')
  assert.match(WORLD, /const lampLights = Array\.from\(\{ length: detail\.lampLights \}/)
  // With no lamp light the per-frame placement returns before scanning the lamp heads.
  assert.match(WORLD, /if \(!lampHeads\.length \|\| !lampLights\.length\) return/)
  assert.match(WORLD, /cloudCoverage: detail\.cloudCoverage \}/)
  assert.match(WORLD, /\{ stepHours: detail\.probeStepHours, onBake:/)
  assert.match(WORLD, /< detail\.resortMetres\) return/)
})

test('world: the lite furniture is about half the triangles of the authored furniture, for the seed\'s lamps, trees and signals', () => {
  const tris = (g: BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3
  // The parts as world.ts furnitureMeshes builds them (only the canopy detail and the lens segments differ).
  const lamp = tris(new CylinderGeometry(0.06, 0.09, 6.2, 8)) + 2 * tris(new BoxGeometry(1, 1, 1))
  const tree = (d: number) => tris(new CylinderGeometry(0.12, 0.18, 3.2, 7)) + 3 * tris(new IcosahedronGeometry(1, d))
  const signal = (w: number, h: number) => tris(new CylinderGeometry(0.08, 0.1, 5.0, 8)) + tris(new BoxGeometry(1, 1, 1)) + 3 * tris(new SphereGeometry(0.1, w, h))
  assert.deepEqual([lamp, tree(1), signal(10, 6)], [56, 268, 344], 'the counts the tier map measured')
  const f = streetFurniture(1337)
  const total = (d: typeof FULL_WORLD) => f.lamps.length * lamp + f.trees.length * tree(d.canopyDetail) + f.signals.length * signal(...d.lensSegments)
  const ratio = total(LITE_WORLD) / total(FULL_WORLD)
  assert.ok(ratio > 0.4 && ratio < 0.55, `lite furniture is ${(100 * ratio).toFixed(1)} % of the authored triangles`)
  // The source builds them from the detail, not from constants.
  const props = between(WORLD, 'function furnitureMeshes(', '\nexport function buildWorld(')
  assert.equal(props.match(/new IcosahedronGeometry\([\d.]+, detail\.canopyDetail\)/g)?.length, 3)
  assert.equal(props.match(/new SphereGeometry\(0\.1, lensW, lensH\)/g)?.length, 3)
})

test('rigs: without rig slots a sync writes and uploads nothing, and lists nobody', () => {
  const view = new RigView(0)
  const versions = () => view.meshes.map((m) => m.instanceMatrix.version)
  const before = versions()
  view.sync(new Float32Array(RIG_POSE.stride).fill(3))
  view.sync(null)
  assert.deepEqual(view.hidden, [])
  assert.deepEqual(versions(), before)
  // With slots, a sync still uploads (the stream's poses move every state).
  const live = new RigView(2)
  const was = live.meshes[0].instanceMatrix.version
  live.sync(null)
  assert.ok(live.meshes[0].instanceMatrix.version > was)
})
