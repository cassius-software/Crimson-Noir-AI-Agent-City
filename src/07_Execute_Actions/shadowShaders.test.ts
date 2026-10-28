// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It builds every material the page draws into its WGSL, under Node, with three's own
 * builder: the main pass and the sun's shadow pass, the shadow pass through the renderer's own renderObject with
 * three's shadow material as the override (so the shadow pass takes what three hands it: the cast-shadow position, the
 * shadow mask, the colour's alpha). The scenes are the ones engine.ts builds: the procedural city with the crowd, the
 * fleet, the rigs and the network ghosts; the lakefront metropolis with its street window and rooms; the embedded
 * region. Every build must finish with nothing logged by three, stay inside a size budget, and call the rain-mode
 * surface (matrixMode.ts) at most once.
 * Rain mode wrapped once per tile onto a region's one facade material made the facade's shadow-pass fragment four
 * times longer per tile, until neither Firefox ("allocation size overflow") nor Chrome ("Invalid string length") could
 * build it: the first shadowed frame of the lakefront metropolis froze for seconds and logged a TSL error twice. The
 * browser job never drew a region with shadows, and no device is needed to see it: the builder only writes text.
 * What breaks if it is removed? A material whose shader grows without bound in either pass, or that takes rain mode
 * twice, would only show on a device drawing that map with shadows on.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import {
  ACESFilmicToneMapping, CubeUVReflectionMapping, DirectionalLight, NoBlending, NodeMaterial, PCFShadowMap, SRGBColorSpace, Texture,
  WGSLNodeBuilder, WebGPURenderer, setConsoleFunction, type Camera, type Light, type Material, type Mesh, type Node, type Object3D, type Scene,
} from 'three/webgpu'
import { texture, vec4 } from 'three/tsl'

// Vite's `?raw` import, for Node: the world, the crowd, the fleet and the rigs take matrix mode, whose WGSL comes that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { buildWorld } = await import('../01_Initialize_World/world.ts')
const { buildLakefrontPack } = await import('../01_Initialize_World/lakefrontPack.ts')
const { RegionPlaces, hollowLots, layoutOf } = await import('../01_Initialize_World/region/regionWorld.ts')
const { streetGridOf } = await import('../01_Initialize_World/region/streets.ts')
const { regionWorkplaceLots } = await import('../01_Initialize_World/region/workplaces.ts')
const { validatePack } = await import('../01_Initialize_World/region/pack.ts')
const { CrowdView } = await import('../03_Spawn_Agents/crowd.ts')
const { FleetView } = await import('./fleetView.ts')
const { RigView } = await import('./rigView.ts')
const { NetView } = await import('./netView.ts')
const { VEHICLE_KINDS } = await import('./car.ts')

/** The page's own seed (App.tsx readOptions: ?seed, 1337 by default). */
const SEED = 1337

/**
 * The most WGSL one stage of one material may be, in characters. The longest the page makes is the city buildings' main
 * fragment, about 82 thousand; the region facade's shadow fragment outgrew the longest string a browser holds (about
 * 500 million characters in Chrome, a billion in Firefox) when it failed.
 */
const STAGE_BUDGET = 256 * 1024

/**
 * A WebGPURenderer never initialised: enough for three's WGSL builder, which only writes text. The canvas is a stand-in
 * and initTexture (fbmTexture.ts uploads its noise through it) does nothing, so no device is ever asked for; the
 * builder's feature questions answer as a device with none of the optional features would. Tone
 * mapping, colour space and the shadow map are set as world.ts createRenderer sets them.
 */
function offlineRenderer(): WebGPURenderer {
  const canvas = { style: {}, width: 1, height: 1, addEventListener() {}, removeEventListener() {}, getContext: () => null }
  const renderer = new WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement, reversedDepthBuffer: true })
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.8
  renderer.outputColorSpace = SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFShadowMap
  // No device: no optional feature (float32-filterable, shader-f16, ...) and WebGPU's default limits, the plainest
  // adapter a browser offers (the limit decides whether an instanced mesh reads its matrices from a uniform buffer).
  // What the WebGPU backend is compatible with (a shadow map sampled with a comparison) it says without a device.
  const backend = renderer.backend as unknown as { capabilities: { getUniformBufferLimit(): number }; hasCompatibility(name: string): boolean }
  Object.assign(renderer, { initTexture: () => {}, hasFeature: () => false, hasCompatibility: (name: string) => backend.hasCompatibility(name) })
  backend.capabilities.getUniformBufferLimit = () => 65536
  return renderer
}

/** The parts of three's renderer and builder this file drives that its typings leave out. */
interface LightsNode { setLights(lights: Light[]): unknown }
interface Internals {
  _handleObjectFunction: (object: Object3D, material: Material) => void
  renderObject(object: Object3D, scene: Scene, camera: Camera, geometry: unknown, material: Material, group: null, lightsNode: LightsNode): void
  lighting: { getNode(scene: Scene): LightsNode }
}
interface BuilderFields {
  scene: Scene; camera: Camera; material: Material; context: { material: Material }; lightsNode: LightsNode; environmentNode: Node | null; fogNode: Node | null
  build(): unknown; vertexShader: string; fragmentShader: string
}

/**
 * The scene's lights node with every light in it, as a frame's render list leaves it (RenderList.js finish), so the
 * main pass carries the sun's shadow lookup and every lamp's light, as on the page.
 */
function lightsOf(renderer: WebGPURenderer, scene: Scene): LightsNode {
  const lights: Light[] = []
  scene.traverse((o) => { if ((o as Light).isLight) lights.push(o as Light) })
  const node = (renderer as unknown as Internals).lighting.getNode(scene)
  node.setLights(lights)
  return node
}

/**
 * The environment the page lights with: the sky probe's bake (envProbe.ts), a PMREM texture, which three reads through
 * texture() (NodeManager.js updateEnvironment). Its pixels are never read here, only its kind.
 */
function environmentOf(): Node {
  // The layout of a 256 px probe's PMREM (three's PMREMGenerator: 3 × 256 across, 4 × 256 down).
  const t = new Texture({ width: 768, height: 1024 })
  t.mapping = CubeUVReflectionMapping
  return texture(t) as unknown as Node
}

/** The sun's shadow-pass material as three makes it (ShadowNode.js getShadowMaterial, for any light but a point light). */
function shadowPassMaterial(): NodeMaterial {
  const m = new NodeMaterial()
  m.colorNode = vec4(0, 0, 0, 1)
  ;(m as NodeMaterial & { isShadowPassMaterial: boolean }).isShadowPassMaterial = true
  m.name = 'ShadowMaterial'
  m.blending = NoBlending
  m.fog = false
  return m
}

interface Stages { vertex: string; fragment: string; logged: string[] }

/** Builds `material` for `object` as three's NodeManager does (NodeManager.js _createNodeBuilder), catching what three logs. */
function build(renderer: WebGPURenderer, scene: Scene, camera: Camera, object: Object3D, material: Material, environment: Node | null = null): Stages {
  const logged: string[] = []
  setConsoleFunction((type: string, message: string) => { if (type !== 'log') logged.push(`${type}: ${String(message).slice(0, 300)}`) })
  try {
    const b = new WGSLNodeBuilder(object, renderer) as unknown as BuilderFields
    b.scene = scene
    b.camera = camera
    b.material = material
    b.context.material = material
    b.lightsNode = lightsOf(renderer, scene)
    b.environmentNode = environment
    b.fogNode = (scene as Scene & { fogNode?: Node }).fogNode ?? null
    b.build()
    return { vertex: b.vertexShader, fragment: b.fragmentShader, logged }
  } finally {
    setConsoleFunction(null as unknown as Parameters<typeof setConsoleFunction>[0])
  }
}

/**
 * Builds `mesh` as the sun's shadow pass draws it: its scene's override material is three's shadow material, and the
 * renderer's own renderObject sets the override's nodes from the mesh's material (Renderer.js renderObject and
 * _getShadowNodes) and hands it on, here to build() in place of drawing.
 */
function buildShadow(renderer: WebGPURenderer, scene: Scene, camera: Camera, mesh: Mesh): Stages {
  const r = renderer as unknown as Internals
  const own = r._handleObjectFunction
  let stages: Stages | null = null
  scene.overrideMaterial = shadowPassMaterial()
  r._handleObjectFunction = (object, material) => { stages = build(renderer, scene, camera, object, material) }
  try {
    r.renderObject(mesh, scene, camera, mesh.geometry, mesh.material as Material, null, lightsOf(renderer, scene))
  } finally {
    r._handleObjectFunction = own
    scene.overrideMaterial = null
  }
  assert.ok(stages, `${mesh.name}: the renderer handed the shadow pass's material on`)
  return stages
}

/** How many times a stage calls the rain-mode surface (its definition, which every stage that calls it carries, aside). */
const surfaceCalls = (wgsl: string): number => (wgsl.match(/\bmatrixSurface\s*\(/g) ?? []).length - (wgsl.match(/\bfn\s+matrixSurface\s*\(/g) ?? []).length

/** One draw of a material: the first mesh drawn with it in each kind of object, with each set of attributes. */
const drawKey = (m: Mesh): string =>
  [(m.material as Material).uuid, m.type, Object.keys(m.geometry.attributes).sort().join(','), (m as Mesh & { instanceColor?: unknown }).instanceColor ? 'colour' : ''].join('|')

interface Report { name: string; pass: 'main' | 'shadow'; vertex: number; fragment: number; surface: number }

/**
 * Builds every distinct draw in `scene`: the main pass for every mesh, the shadow pass for every mesh that casts one
 * (PCF shadows draw only casters). Returns what was built; every check is made on the way.
 */
function buildScene(label: string, renderer: WebGPURenderer, scene: Scene, camera: Camera): Report[] {
  const sun = scene.children.find((o): o is DirectionalLight => (o as DirectionalLight).isDirectionalLight === true)
  assert.ok(sun?.castShadow, `${label}: the sun casts shadows`)
  const draws = new Map<string, Mesh>()
  scene.traverse((o) => {
    const m = o as Mesh
    if (m.isMesh && !Array.isArray(m.material) && !draws.has(drawKey(m))) draws.set(drawKey(m), m)
  })
  const environment = environmentOf()
  const out: Report[] = []
  const check = (mesh: Mesh, pass: Report['pass'], s: Stages) => {
    const name = `${label}: ${mesh.name || mesh.type}, ${pass} pass`
    assert.deepEqual(s.logged, [], `${name}: three logged nothing while building it`)
    assert.ok(s.vertex.length > 0 && s.fragment.length > 0, `${name}: both stages built`)
    assert.ok(s.vertex.length <= STAGE_BUDGET, `${name}: vertex stage ${s.vertex.length} characters, budget ${STAGE_BUDGET}`)
    assert.ok(s.fragment.length <= STAGE_BUDGET, `${name}: fragment stage ${s.fragment.length} characters, budget ${STAGE_BUDGET}`)
    assert.equal(surfaceCalls(s.vertex), 0, `${name}: the vertex stage never calls the rain-mode surface`)
    const surface = surfaceCalls(s.fragment)
    assert.ok(surface <= 1, `${name}: the rain-mode surface is called ${surface} times; a material takes rain mode once`)
    out.push({ name: mesh.name || mesh.type, pass, vertex: s.vertex.length, fragment: s.fragment.length, surface })
  }
  for (const mesh of draws.values()) {
    check(mesh, 'main', build(renderer, scene, camera, mesh, mesh.material as Material, environment))
    if (mesh.castShadow) check(mesh, 'shadow', buildShadow(renderer, scene, sun.shadow.camera, mesh))
  }
  return out
}

/** The lakefront metropolis as engine.ts builds it: its street window round the start, and the rooms on its lots. */
function lakefront(renderer: WebGPURenderer) {
  const pack = buildLakefrontPack(SEED)
  const layout = layoutOf(pack)
  const start = new RegionPlaces(pack, layout).spawn({ x: layout.offset.x, z: layout.offset.z })
  const streets = streetGridOf(pack, layout.offset, start)
  assert.ok(streets, 'the metropolis has a street window')
  const hollow = hollowLots(pack, layout, regionWorkplaceLots(pack, layout, streets, start, SEED))
  return buildWorld(renderer, SEED, { pack: hollow.pack, layout: { ...layout, floors: hollow.floors }, streets, plan: hollow.plan })
}

/** The region every build carries (vite.config.ts regionPack, App.tsx loadRegion), walked with ?region=on: no window, no lots. */
function embeddedRegion(renderer: WebGPURenderer) {
  const file = fileURLToPath(new URL('../../world/pilot.region.json.gz', import.meta.url))
  const pack = validatePack(JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')))
  const layout = layoutOf(pack)
  const hollow = hollowLots(pack, layout, [])
  return buildWorld(renderer, SEED, { pack: hollow.pack, layout: { ...layout, floors: hollow.floors }, streets: null, plan: hollow.plan })
}

const tiles = (scene: Scene): Mesh[] => scene.children.filter((o): o is Mesh => o.name.startsWith('RegionBuildings '))

test('the procedural city, its crowd, fleet, rigs and network ghosts: every material builds in both passes, inside the budget, rain mode once', () => {
  const renderer = offlineRenderer()
  const world = buildWorld(renderer, SEED)
  const crowd = new CrowdView(64, world.matrixMode.globalState)
  const kinds = VEHICLE_KINDS.map((_k, i) => i)
  const fleet = new FleetView(kinds, kinds.map(() => 0x808080), world.night, world.matrixMode.globalState)
  const rigs = new RigView(2, world.matrixMode.globalState)
  const net = new NetView()
  world.scene.add(...crowd.meshes, ...fleet.bodies, fleet.wheels, ...rigs.meshes, net.people, net.cars)
  const built = buildScene('city', renderer, world.scene, world.camera)
  const shadowed = new Set(built.filter((b) => b.pass === 'shadow').map((b) => b.name))
  for (const name of ['Buildings', 'StreetLamps', 'StreetTrees', 'TrafficSignals', 'Wheels']) assert.ok(shadowed.has(name), `city: ${name} was built for the shadow pass`)
  // The crowd: four bodies at two levels of detail, a material each; the rigs' thirteen parts share one.
  assert.equal([...shadowed].filter((n) => n.startsWith('People.')).length, crowd.meshes.length, 'city: every body of the crowd was built for the shadow pass')
  assert.ok([...shadowed].some((n) => n.startsWith('Rig ')), 'city: the rigs were built for the shadow pass')
  assert.equal([...shadowed].filter((n) => n.startsWith('Cars:')).length, VEHICLE_KINDS.length, 'city: every vehicle kind was built for the shadow pass')
})

test('the lakefront metropolis: every material builds in both passes, the facade every tile shares included, inside the budget, rain mode once', () => {
  const renderer = offlineRenderer()
  const world = lakefront(renderer)
  assert.ok(tiles(world.scene).length >= 20, `the metropolis is drawn in many tiles (${tiles(world.scene).length}), as the one that failed was`)
  const built = buildScene('lakefront', renderer, world.scene, world.camera)
  const facade = built.find((b) => b.name.startsWith('RegionBuildings ') && b.pass === 'shadow')
  assert.ok(facade, 'lakefront: the facade was built for the shadow pass')
  assert.equal(facade.surface, 1, 'lakefront: the facade\'s shadow pass reads rain mode once, not once per tile')
})

test('the embedded region: every material builds in both passes, inside the budget, rain mode once', () => {
  const renderer = offlineRenderer()
  const world = embeddedRegion(renderer)
  assert.ok(tiles(world.scene).length > 1, 'the region is drawn in more than one tile')
  buildScene('region', renderer, world.scene, world.camera)
})

test('a region\'s tiles share one facade material, which has rain mode once however many tiles there are', () => {
  const renderer = offlineRenderer()
  const world = lakefront(renderer)
  const facades = new Set(tiles(world.scene).map((m) => m.material))
  assert.equal(facades.size, 1, 'one facade material for every tile')
  const [tile] = tiles(world.scene)
  const one = buildShadow(renderer, world.scene, world.camera, tile)
  // Another tile, drawn with the same material, builds the same shadow shader: nothing about the facade grows per tile.
  const last = tiles(world.scene).at(-1)!
  assert.equal(buildShadow(renderer, world.scene, world.camera, last).fragment, one.fragment)
})
