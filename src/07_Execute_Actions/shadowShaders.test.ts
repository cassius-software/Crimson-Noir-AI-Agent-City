// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It builds every material the page draws into its WGSL, under Node, with three's own
 * builder: the main pass and the sun's shadow pass, the shadow pass through three's own shadow node (its shadow material
 * as the override and its render-object function, which hands each caster to the renderer's renderObject), so the
 * shadow pass takes what three hands it: the cast-shadow position, the shadow mask, the colour's alpha. The scenes are the ones engine.ts builds: the procedural city with the crowd, the
 * fleet, the rigs and the network ghosts; the lakefront metropolis with its street window and rooms; the embedded
 * region. Every build must finish with nothing logged by three, stay inside a size budget, and call the rain-mode
 * surface (matrixMode.ts) once (no more for any material, and exactly once for every one that takes the mode).
 * Rain mode wrapped once per tile onto a region's one facade material made the facade's shadow-pass fragment four
 * times longer per tile, until neither Firefox ("allocation size overflow") nor Chrome ("Invalid string length") could
 * build it: the first shadowed frame of the lakefront metropolis froze for seconds and logged a TSL error twice. The
 * browser job never drew a region with shadows, and no device is needed to see it: the builder only writes text.
 * Each stage's bindings are counted against what WebGPU promises every adapter (twelve uniform buffers a stage, eight
 * storage buffers, sixteen textures and samplers): the crowd's fragment stage reached thirteen uniform buffers, one
 * per palette, when the wardrobe's coats, trims and scarves were added, and no body's pipeline built on any device.
 * What breaks if it is removed? A material whose shader grows without bound in either pass, or that takes rain mode
 * twice, or that binds more than a stage is promised, would only show on a device drawing that map with shadows on.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import {
  ACESFilmicToneMapping, CubeUVReflectionMapping, PCFShadowMap, PMREMGenerator, SRGBColorSpace, Texture,
  WGSLNodeBuilder, WebGPURenderer, setConsoleFunction, type Camera, type InstancedMesh, type Light, type Material, type Mesh, type Node,
  type Object3D, type PointLight, type Scene,
} from 'three/webgpu'
import { texture } from 'three/tsl'
import { SunShadowNode } from 'three/addons/lights/SunShadowNode.js'
import type { SunLight } from 'three/addons/lights/SunLight.js'

// Vite's `?raw` import, for Node: the world, the crowd, the fleet and the rigs take matrix mode, whose WGSL comes that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { buildWorld, FULL_WORLD, LITE_WORLD } = await import('../01_Initialize_World/world.ts')
const { CityLightsNode, FIXTURE, LAMP } = await import('../01_Initialize_World/cityLights.ts')
const { SHADOW_TAPS, SUN_SHADOW } = await import('../01_Initialize_World/sunShadow.ts')
const { workplaces } = await import('../01_Initialize_World/interiors.ts')
const { buildLakefrontPack } = await import('../01_Initialize_World/lakefrontPack.ts')
const { RegionPlaces, hollowLots, layoutOf } = await import('../01_Initialize_World/region/regionWorld.ts')
const { streetGridOf } = await import('../01_Initialize_World/region/streets.ts')
const { regionWorkplaceLots } = await import('../01_Initialize_World/region/workplaces.ts')
const { validatePack } = await import('../01_Initialize_World/region/pack.ts')
const { CrowdView } = await import('../03_Spawn_Agents/crowd.ts')
const { FleetView } = await import('./fleetView.ts')
const { CraftView } = await import('./craftView.ts')
const { TrackFleet } = await import('./trackFleet.ts')
const { buildTrackNetwork } = await import('../06_Make_Decisions/tracks.ts')
const { RigView } = await import('./rigView.ts')
const { NetView } = await import('./netView.ts')
const { VEHICLE_KINDS } = await import('./car.ts')
const { CROWD_DEFAULT } = await import('../05_Observe_Environment/governor.ts')

/** The page's own seed (App.tsx readOptions: ?seed, 1337 by default). */
const SEED = 1337

/**
 * The most WGSL one stage of one material may be, in characters. The longest the page makes is the city buildings' main
 * fragment, about 82 thousand; the region facade's shadow fragment outgrew the longest string a browser holds (about
 * 500 million characters in Chrome, a billion in Firefox) when it failed.
 */
const STAGE_BUDGET = 256 * 1024

/**
 * The most WGSL the near crowd body's main fragment stage may be, in characters: a target of its own, inside
 * STAGE_BUDGET. That stage is the page's longest, the whole wardrobe's paint (221,913 at its worst before the crowd's
 * hash was written once and its cloths declared once, about 172 thousand after), and every wardrobe slice adds to it,
 * so the room a slice leaves the next is held here rather than found at the budget, where no pipeline is left to
 * spare.
 */
const NEAR_TARGET = 225_000

/** The near bodies of the crowd (crowd.ts names each mesh People.<body>.lod<level>; level 0 is the near one). */
const NEAR_BODY = /^People\..+\.lod0$/

/**
 * The bindings WebGPU promises a stage on every adapter (maxUniformBuffersPerShaderStage, maxStorageBuffersPerShaderStage,
 * maxSampledTexturesPerShaderStage, maxSamplersPerShaderStage): three lays the pipeline out from the bindings a stage
 * declares, and a layout past one of them never builds, whatever the device.
 */
const BINDING_LIMIT = { 'uniform buffers': 12, 'storage buffers': 8, 'sampled textures': 16, samplers: 16 } as const
type BindingKind = keyof typeof BINDING_LIMIT

/** How many bindings of each kind a stage's WGSL declares (three's WGSLNodeBuilder getUniforms writes one line each). */
function bindings(wgsl: string): Record<BindingKind, number> {
  const count = (re: RegExp): number => (wgsl.match(re) ?? []).length
  return {
    'uniform buffers': count(/\bvar<uniform>/g),
    'storage buffers': count(/\bvar<storage/g),
    'sampled textures': count(/@group\(\s*\d+\s*\)\s*var\s+\w+\s*:\s*texture_/g),
    samplers: count(/@group\(\s*\d+\s*\)\s*var\s+\w+\s*:\s*sampler(?:_comparison)?\s*;/g),
  }
}

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

/** The parts of three's renderer, shadow node and builder this file drives that their typings leave out. */
interface LightsNode { setLights(lights: Light[]): unknown }
interface Internals {
  _handleObjectFunction: (object: Object3D, material: Material) => void
  lighting: { getNode(scene: Scene): LightsNode }
}
type RenderObjectFunction = (
  object: Object3D, scene: Scene, camera: Camera, geometry: unknown, material: Material, group: null, lightsNode: LightsNode, clippingContext: null, passId: null,
) => void
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

interface Stages { vertex: string; fragment: string }

/** Runs `fn` with three's console caught: what three says that is not a plain log line (a warning, an error). */
function caught<T>(fn: () => T): { value: T; logged: string[] } {
  const logged: string[] = []
  setConsoleFunction((type: string, message: string) => { if (type !== 'log') logged.push(`${type}: ${String(message).slice(0, 300)}`) })
  try {
    return { value: fn(), logged }
  } finally {
    setConsoleFunction(null as unknown as Parameters<typeof setConsoleFunction>[0])
  }
}

/** Builds `material` for `object` as three's NodeManager does (NodeManager.js _createNodeBuilder). */
function build(renderer: WebGPURenderer, scene: Scene, camera: Camera, object: Object3D, material: Material, environment: Node | null = null): Stages {
  const b = new WGSLNodeBuilder(object, renderer) as unknown as BuilderFields
  b.scene = scene
  b.camera = camera
  b.material = material
  b.context.material = material
  b.lightsNode = lightsOf(renderer, scene)
  b.environmentNode = environment
  b.fogNode = (scene as Scene & { fogNode?: Node }).fogNode ?? null
  b.build()
  return { vertex: b.vertexShader, fragment: b.fragmentShader }
}

/**
 * Builds `mesh` as the sun's shadow pass draws it, with three's own shadow node for the sun (SunShadowNode, a
 * ShadowNode: ShadowNode.js updateShadow): its shadow material is the scene's override and its render-object function
 * takes the mesh, which hands it to the renderer's renderObject; that sets the override's nodes from the mesh's material
 * (Renderer.js renderObject and _getShadowNodes) and hands the material on, here to build() in place of drawing. Every
 * material handed on is built and returned. The camera is the first cascade's (the pass draws each cascade with its own;
 * the shadow material is the same for both).
 */
function buildShadow(renderer: WebGPURenderer, scene: Scene, sun: SunLight, mesh: Mesh): { value: Stages[]; logged: string[] } {
  const r = renderer as unknown as Internals
  const shadow = new SunShadowNode(sun)
  const camera = sun.shadow.getCamera(0)
  const renderObject = shadow.getShadowRenderObjectFunction(renderer, sun.shadow) as unknown as RenderObjectFunction
  const own = r._handleObjectFunction
  const built: Stages[] = []
  scene.overrideMaterial = shadow.getShadowMaterial()
  r._handleObjectFunction = (object, material) => { built.push(build(renderer, scene, camera, object, material)) }
  try {
    return caught(() => {
      renderObject(mesh, scene, camera, mesh.geometry, mesh.material as Material, null, lightsOf(renderer, scene), null, null)
      return built
    })
  } finally {
    r._handleObjectFunction = own
    scene.overrideMaterial = null
  }
}

/** How many times a stage calls the rain-mode surface (its definition, which every stage that calls it carries, aside). */
const surfaceCalls = (wgsl: string): number => (wgsl.match(/\bmatrixSurface\s*\(/g) ?? []).length - (wgsl.match(/\bfn\s+matrixSurface\s*\(/g) ?? []).length

/**
 * How an instanced mesh reads its matrices, which changes its vertex stage (three's Instance.js createInstanceMatrixNode):
 * a storage buffer, a uniform buffer while they fit in one, an instanced attribute past that.
 */
function instancing(m: Mesh): string {
  const matrices = (m as InstancedMesh).isInstancedMesh ? (m as InstancedMesh).instanceMatrix : null
  if (!matrices) return ''
  if ((matrices as typeof matrices & { isStorageInstancedBufferAttribute?: boolean }).isStorageInstancedBufferAttribute) return 'storage'
  return Math.max(matrices.count, 1) * 64 <= 65536 ? 'uniform' : 'attribute'
}

/** One draw of a material: the first mesh drawn with it in each kind of object, with each set of attributes and instancing. */
const drawKey = (m: Mesh): string =>
  [(m.material as Material).uuid, m.type, Object.keys(m.geometry.attributes).sort().join(','), (m as Mesh & { instanceColor?: unknown }).instanceColor ? 'colour' : '', instancing(m)].join('|')

/**
 * The draws that do not take rain mode: the sky (SkyMesh, three's own), and the network room's ghosts, which only a
 * network room draws and which are only ever seen in rain mode as the dim figures they are (netView.ts).
 */
const NO_RAIN_MODE = (name: string): boolean => name === 'Mesh' || name === 'NetPeople' || name === 'NetCars'

interface Report { name: string; pass: 'main' | 'shadow'; vertex: number; fragment: number; surface: number; uniforms: number; storage: number }

/**
 * Builds every distinct draw in `scene`: the main pass for every mesh, the shadow pass for every mesh that casts one
 * (PCF shadows draw only casters). Returns what was built; every check is made on the way.
 */
function buildScene(label: string, renderer: WebGPURenderer, scene: Scene, camera: Camera): Report[] {
  const sun = scene.children.find((o): o is SunLight => (o as SunLight).isSunLight === true)
  assert.ok(sun?.castShadow, `${label}: the sun casts shadows`)
  const draws = new Map<string, Mesh>()
  scene.traverse((o) => {
    const m = o as Mesh
    if (m.isMesh && !Array.isArray(m.material) && !draws.has(drawKey(m))) draws.set(drawKey(m), m)
  })
  const environment = environmentOf()
  const out: Report[] = []
  const check = (mesh: Mesh, pass: Report['pass'], { value: built, logged }: { value: Stages[]; logged: string[] }) => {
    const draw = mesh.name || mesh.type
    const name = `${label}: ${draw}, ${pass} pass`
    assert.deepEqual(logged, [], `${name}: three logged nothing while building it`)
    assert.equal(built.length, 1, `${name}: one material built for the draw`)
    for (const s of built) {
      assert.ok(s.vertex.length > 0 && s.fragment.length > 0, `${name}: both stages built`)
      assert.ok(s.vertex.length <= STAGE_BUDGET, `${name}: vertex stage ${s.vertex.length} characters, budget ${STAGE_BUDGET}`)
      assert.ok(s.fragment.length <= STAGE_BUDGET, `${name}: fragment stage ${s.fragment.length} characters, budget ${STAGE_BUDGET}`)
      if (pass === 'main' && NEAR_BODY.test(draw)) {
        assert.ok(s.fragment.length <= NEAR_TARGET, `${name}: the near body's fragment stage is ${s.fragment.length} characters, target ${NEAR_TARGET}`)
        // Where a chosen look's ink shows (crowd.ts inkShown, its beard's cover from 1.548 up in front of z -0.03): written
        // once, at the top of the stage, so the gold leaf's branch and the luminescent glow's read it set. First reached
        // inside the gold leaf's branch, it was written there alone and the glow read the beard's test unset.
        const gates = [...s.fragment.matchAll(/\.y > 1\.548 \) \) && \( \w+\.z > -0\.03 \)/g)]
        assert.equal(gates.length, 1, `${name}: the inks' cover is written once`)
        const head = s.fragment.slice(s.fragment.indexOf('fn main('), gates[0].index)
        assert.equal((head.match(/\{/g)?.length ?? 0) - (head.match(/\}/g)?.length ?? 0), 1, `${name}: the inks' cover is written at the top of the stage, under no branch`)
      }
      assert.equal(surfaceCalls(s.vertex), 0, `${name}: the vertex stage never calls the rain-mode surface`)
      const surface = surfaceCalls(s.fragment)
      assert.ok(surface <= 1, `${name}: the rain-mode surface is called ${surface} times; a material takes rain mode once`)
      if (pass === 'main' && !NO_RAIN_MODE(draw)) assert.equal(surface, 1, `${name}: the material takes rain mode`)
      const bound = { vertex: bindings(s.vertex), fragment: bindings(s.fragment) }
      for (const stage of ['vertex', 'fragment'] as const) {
        for (const kind of Object.keys(BINDING_LIMIT) as BindingKind[]) {
          assert.ok(bound[stage][kind] <= BINDING_LIMIT[kind], `${name}: the ${stage} stage declares ${bound[stage][kind]} ${kind}; WebGPU promises ${BINDING_LIMIT[kind]}`)
        }
      }
      out.push({
        name: draw, pass, vertex: s.vertex.length, fragment: s.fragment.length, surface,
        uniforms: Math.max(bound.vertex['uniform buffers'], bound.fragment['uniform buffers']), storage: Math.max(bound.vertex['storage buffers'], bound.fragment['storage buffers']),
      })
    }
  }
  for (const mesh of draws.values()) {
    const main = caught(() => [build(renderer, scene, camera, mesh, mesh.material as Material, environment)])
    check(mesh, 'main', main)
    if (mesh.castShadow) check(mesh, 'shadow', buildShadow(renderer, scene, sun, mesh))
  }
  if (process.env.SHADOW_SHADERS_REPORT) console.table(out)
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
  return buildWorld(renderer, SEED, { pack: hollow.pack, layout: { ...layout, floors: hollow.floors }, streets, plan: hollow.plan, rooms: hollow.rooms })
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
  // The page's own crowd on a desktop (governor.ts defaultAgents): more bodies than one uniform buffer holds matrices for.
  const crowd = new CrowdView(CROWD_DEFAULT.full, world.matrixMode.globalState)
  const kinds = VEHICLE_KINDS.map((_k, i) => i)
  const fleet = new FleetView(kinds, kinds.map(() => 0x808080), world.night, world.matrixMode.globalState)
  const rigs = new RigView(2, world.matrixMode.globalState)
  const net = new NetView()
  // The scheduled craft and the loop's structure, over the realm's own network (the page builds it from the same boxes).
  const network = buildTrackNetwork(SEED, world.boxes)
  const craft = new CraftView(network, new TrackFleet(network).count, world.night, world.matrixMode.globalState)
  world.scene.add(...crowd.meshes, ...fleet.bodies, fleet.wheels, ...rigs.meshes, net.people, net.cars, ...craft.meshes)
  const built = buildScene('city', renderer, world.scene, world.camera)
  const shadowed = new Set(built.filter((b) => b.pass === 'shadow').map((b) => b.name))
  // The guideway's beams share the columns' material, geometry attributes and instancing: one draw, built once as the columns.
  for (const name of ['Buildings', 'StreetLamps', 'StreetTrees', 'TrafficSignals', 'Wheels', 'Trains', 'VTOLs', 'VTOLPads', 'Guideway', 'GuidewayColumns']) assert.ok(shadowed.has(name), `city: ${name} was built for the shadow pass`)
  const mains = new Set(built.filter((b) => b.pass === 'main').map((b) => b.name))
  for (const name of ['Drones', 'Planes']) assert.ok(mains.has(name) && !shadowed.has(name), `city: ${name} is drawn and casts no shadow`)
  // The homes' finishes and furniture: the buildings' material read through a uniform buffer of transforms (its 512
  // slots fit one), a draw of its own beside the buildings' instanced attributes, indoors under the slab, no shadow.
  assert.ok(mains.has('HomeFurniture') && !shadowed.has('HomeFurniture'), 'city: HomeFurniture is drawn and casts no shadow')
  // The crowd: four bodies at two levels of detail, a material each; the rigs' thirteen parts share one.
  assert.equal([...shadowed].filter((n) => n.startsWith('People.')).length, crowd.meshes.length, 'city: every body of the crowd was built for the shadow pass')
  // The near bodies' main fragments were built, so each was held to NEAR_TARGET on the way (buildScene's check).
  assert.equal([...mains].filter((n) => NEAR_BODY.test(n)).length, crowd.meshes.length / 2, 'city: every near body of the crowd was built for the main pass')
  // Its shadow pass draws the pose and the dissolve's shadow mask, nothing of the paint: three multiplies the shadow's
  // alpha by the colour's, which once wrote every weave and cut into the shadow map's fragment stage (about 138
  // thousand characters, run for every texel a body covers; the browser job outran its half hour).
  for (const b of built.filter((r) => r.pass === 'shadow' && r.name.startsWith('People.'))) assert.ok(b.fragment <= 4096, `city: ${b.name}'s shadow fragment is ${b.fragment} characters, not the paint`)
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

test('a region\'s tiles share one facade material, and every tile\'s shadow pass reads rain mode once', () => {
  const renderer = offlineRenderer()
  const world = lakefront(renderer)
  const all = tiles(world.scene)
  assert.equal(new Set(all.map((m) => m.material)).size, 1, 'one facade material for every tile')
  const sun = world.sun
  // The first tile and the last: however many tiles share it, the facade carries rain mode once.
  for (const tile of [all[0], all.at(-1)!]) {
    const { value: [s], logged } = buildShadow(renderer, world.scene, sun, tile)
    assert.deepEqual(logged, [], `${tile.name}: three logged nothing while building its shadow pass`)
    assert.equal(surfaceCalls(s.fragment), 1, `${tile.name}: its shadow pass reads rain mode once`)
  }
})

/**
 * Runs `fn` with the sky probe's bake stubbed (World.update bakes it through three's PMREMGenerator, which needs a
 * device): the probe is a texture whose pixels nothing here reads.
 */
function withoutProbe<T>(fn: () => T): T {
  const own = PMREMGenerator.prototype.fromScene
  const stub = (_scene: Scene, _sigma: number, _near: number, _far: number, options: { renderTarget?: unknown }) => options.renderTarget ?? { texture: new Texture() }
  PMREMGenerator.prototype.fromScene = stub as unknown as typeof own
  try {
    return fn()
  } finally {
    PMREMGenerator.prototype.fromScene = own
  }
}

/** The scene's point lights (the lamps' and the rooms' fixtures'): the whole pool, lit or not. */
const pointLights = (scene: Scene): PointLight[] => scene.children.filter((o): o is PointLight => (o as PointLight).isPointLight === true)
/** A mesh that casts the sun's shadow (the ground only receives it, and three's shadow pass skips what does not cast). */
const caster = (scene: Scene): Mesh => {
  let found: Mesh | undefined
  scene.traverse((o) => { if (!found && (o as Mesh).isMesh && o.castShadow) found = o as Mesh })
  assert.ok(found, 'something casts the sun\'s shadow')
  return found
}
const streets = (scene: Scene): Mesh => {
  const m = scene.getObjectByName('Streets') as Mesh | undefined
  assert.ok(m, 'the city ground is drawn')
  return m
}

test('the lamps are clustered: one lit shader whatever the count of lit lamps, the cluster grid read in the main pass only, none of it in a lite boot', () => {
  const renderer = offlineRenderer()
  const world = buildWorld(renderer, SEED)
  const lights = pointLights(world.scene)
  const rooms = workplaces(SEED).length
  assert.equal(lights.length, FULL_WORLD.lampLights + FIXTURE.at.length * rooms, 'the lamp pool and four fixtures a room')
  assert.ok(lights.every((l) => !l.visible), 'nothing is lit before the first update')
  assert.ok((renderer as unknown as Internals).lighting.getNode(world.scene) instanceof CityLightsNode, 'the city scene gets the clustered node')
  // A night update with the tier's count: that many lamps, the nearest to the focus, and every fixture.
  world.setLampLights(128)
  withoutProbe(() => world.update(23, 0, 320, 320))
  const lit = lights.filter((l) => l.visible)
  assert.equal(lit.length, 128 + FIXTURE.at.length * rooms)
  const lamps = lit.filter((l) => l.distance === LAMP.range)
  assert.equal(lamps.length, 128)
  assert.ok(lamps.every((l) => Math.abs(l.intensity - LAMP.candela) < 1e-6 && l.position.y === LAMP.height), 'a lit lamp shines LAMP.candela from its head')
  const far = Math.max(...lamps.map((l) => Math.hypot(l.position.x - 320, l.position.z - 320)))
  assert.ok(far < 100, `128 lamps round the focus reach ${far.toFixed(0)} m`)
  // The main pass reads the grid's index buffer and the lights' texture; its WGSL is the same for six lit lamps or
  // a hundred and twenty-eight (the count is a uniform), so a tier change never recompiles.
  const ground = streets(world.scene)
  const environment = environmentOf()
  // (The first build of a material primes three's node caches and lays its text out a little differently from every
  // build after it, whatever the lights; the builds compared are the settled ones.)
  build(renderer, world.scene, world.camera, ground, ground.material as Material, environment)
  const many = build(renderer, world.scene, world.camera, ground, ground.material as Material, environment)
  assert.match(many.fragment, /lightIndexes/, 'the main pass reads the cluster grid')
  const lightsKey = (lightsOf(renderer, world.scene) as unknown as Node).getCacheKey(true)
  world.setLampLights(6)
  withoutProbe(() => world.update(23, 0, 320, 320))
  assert.equal(pointLights(world.scene).filter((l) => l.visible && l.distance === LAMP.range).length, 6)
  const few = build(renderer, world.scene, world.camera, ground, ground.material as Material, environment)
  assert.equal(few.fragment, many.fragment, 'the same fragment stage for six lit lamps and for 128')
  assert.equal((lightsOf(renderer, world.scene) as unknown as Node).getCacheKey(true), lightsKey, 'the lights node keys the pipeline the same: nothing recompiles')
  assert.equal(few.vertex, many.vertex)
  // By day the lamps go dark and unlit (the fixtures stay: a workplace is lit by day), without a change of shader.
  withoutProbe(() => world.update(12, 0, 320, 320))
  assert.equal(pointLights(world.scene).filter((l) => l.visible).length, FIXTURE.at.length * rooms, 'by day the lamps are not lit')
  assert.equal(build(renderer, world.scene, world.camera, ground, ground.material as Material, environment).fragment, many.fragment)
  assert.equal((lightsOf(renderer, world.scene) as unknown as Node).getCacheKey(true), lightsKey)
  // The shadow pass never pays for the grid.
  const sun = world.sun
  const passes = buildShadow(renderer, world.scene, sun, caster(world.scene)).value
  assert.ok(passes.length > 0, 'a caster builds a shadow pass')
  for (const s of passes) assert.doesNotMatch(s.fragment, /lightIndexes/, 'the shadow pass reads no cluster grid')
  // A count of 0 lights nothing, fixtures included.
  world.setLampLights(0)
  withoutProbe(() => world.update(23, 0, 320, 320))
  assert.equal(pointLights(world.scene).filter((l) => l.visible).length, 0)
  // A lite boot: no point lights, no clustered node, no grid in the shader.
  const liteRenderer = offlineRenderer()
  const lite = buildWorld(liteRenderer, SEED, null, LITE_WORLD)
  assert.equal(pointLights(lite.scene).length, 0)
  assert.ok(!((liteRenderer as unknown as Internals).lighting.getNode(lite.scene) instanceof CityLightsNode))
  lite.setLampLights(128)
  withoutProbe(() => lite.update(23, 0, 320, 320))
  const liteGround = streets(lite.scene)
  assert.doesNotMatch(build(liteRenderer, lite.scene, lite.camera, liteGround, liteGround.material as Material, environment).fragment, /lightIndexes/)
})

test('the lakefront metropolis lights its rooms: four fixtures a room under the ceiling, the lamps of its street window clustered', () => {
  const renderer = offlineRenderer()
  const world = lakefront(renderer)
  const lights = pointLights(world.scene)
  const fixtures = lights.filter((l) => l.distance === FIXTURE.range)
  assert.ok(fixtures.length > 0 && fixtures.length % FIXTURE.at.length === 0, `${fixtures.length} fixtures`)
  assert.equal(lights.length - fixtures.length, FULL_WORLD.lampLights)
  world.setLampLights(64)
  withoutProbe(() => world.update(23, 0, world.camera.position.x, world.camera.position.z))
  assert.equal(lights.filter((l) => l.visible).length, 64 + fixtures.length)
  assert.ok((renderer as unknown as Internals).lighting.getNode(world.scene) instanceof CityLightsNode)
})

test('the sun shadows in two cascades with the soft filter: one lit shader whatever the taps, the distance or the map size', () => {
  const renderer = offlineRenderer()
  const world = buildWorld(renderer, SEED)
  const sun = world.sun
  assert.ok((sun as unknown as { isSunLight?: boolean }).isSunLight, 'the sun is three\'s cascaded sun light')
  assert.equal(sun.shadow.getViewportCount(), 2, 'two cascades')
  assert.deepEqual([sun.shadow.getFrameExtents().x, sun.shadow.getFrameExtents().y], [2, 1], 'side by side in one atlas')
  assert.equal(sun.shadow.camera.far, SUN_SHADOW.distance)
  assert.equal(sun.shadow.radius, SUN_SHADOW.radius)
  assert.equal(renderer.library.getLightNodeClass(sun.constructor as new () => Light)?.name, 'SunLightNode', 'the renderer knows the sun light')
  const ground = streets(world.scene)
  const environment = environmentOf()
  build(renderer, world.scene, world.camera, ground, ground.material as Material, environment)
  const first = build(renderer, world.scene, world.camera, ground, ground.material as Material, environment)
  // The filter: hardware depth comparisons, SHADOW_TAPS.max of them written out a cascade (no loop: a compiler that
  // refuses screen-derivative reads in a loop it cannot count would leave the material unbuilt), every one past three's
  // five behind an `if` on the one taps uniform, and the disk scaled per axis (round on the 2 : 1 atlas).
  const compares = [...first.fragment.matchAll(/textureSampleCompare\s*\(/g)].map((m) => m.index)
  assert.equal(compares.length, 2 * SHADOW_TAPS.max, `${SHADOW_TAPS.max} comparisons a cascade, written out (${compares.length})`)
  const span = first.fragment.slice(compares[0], compares[compares.length - 1])
  assert.doesNotMatch(span, /\bfor\s*\(|\bloop\s*\{|\bwhile\b/, 'no loop among the taps')
  const gates = [...span.matchAll(/if \( \( (\w+\.\w+) > (\d+) \) \)/g)]
  const extra = SHADOW_TAPS.max - SHADOW_TAPS.min
  assert.equal(gates.length, 2 * extra, `the ${extra} taps past three's five behind an if a cascade (${gates.length})`)
  assert.equal(new Set(gates.map((g) => g[1])).size, 1, 'one uniform gates them all: the taps')
  assert.deepEqual([...new Set(gates.map((g) => Number(g[2])))].sort((x, y) => x - y), Array.from({ length: extra }, (_, k) => SHADOW_TAPS.min + k))
  assert.match(span, /vec2<f32>\( (\w+\.\w+), \1 \) \/ \w+\.\w+/, 'the radius over the atlas size per axis')
  // The knobs the tiers write are uniforms: the WGSL does not move, nor the lights node's key.
  const lightsKey = (lightsOf(renderer, world.scene) as unknown as Node).getCacheKey(true)
  world.setShadowTaps(16)
  sun.shadow.radius = 3
  sun.shadow.camera.far = 320
  sun.shadow.mapSize.set(4096, 4096)
  const peak = build(renderer, world.scene, world.camera, ground, ground.material as Material, environment)
  assert.equal(peak.fragment, first.fragment, 'the same fragment stage for 8 taps at 160 m and 16 taps at 320 m (any reach: the far plane is a uniform)')
  assert.equal(peak.vertex, first.vertex)
  assert.equal((lightsOf(renderer, world.scene) as unknown as Node).getCacheKey(true), lightsKey)
  world.setShadowTaps(5)
  sun.shadow.radius = 1.5
  sun.shadow.camera.far = 120
  sun.shadow.mapSize.set(1024, 1024)
  assert.equal(build(renderer, world.scene, world.camera, ground, ground.material as Material, environment).fragment, first.fragment, 'and for Medium\'s five taps at 120 m')
  // Parked (quality.ts): intensity and the update flag are the shadow's own, read as uniforms too.
  sun.shadow.intensity = 0
  assert.equal(build(renderer, world.scene, world.camera, ground, ground.material as Material, environment).fragment, first.fragment)
  // The shadow pass itself carries no filter and no cascade walk (built for a caster: three draws nothing else in it).
  const passes = buildShadow(renderer, world.scene, sun, caster(world.scene)).value
  assert.ok(passes.length > 0, 'a caster builds a shadow pass')
  for (const st of passes) assert.doesNotMatch(st.fragment, /textureSampleCompare/, 'the shadow pass compares no shadow')
})
