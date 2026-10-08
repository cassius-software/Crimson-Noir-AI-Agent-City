// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It stands up the WebGPU device (refusing the WebGL fallback, because the
 * crowd is raw WGSL compute) and assembles the static world under a moving sun: physically based sky
 * with clouds, sun/moon light and shadows, aerial haze, an environment probe that follows the time of
 * day, the instanced buildings, streets, lamps, trees and traffic signals. It also owns the resident
 * set of procedural texture resolutions the quality autoscaler swaps between.
 * What breaks if it is removed? There is no renderer, no device for the compute passes, and no city.
 */
import {
  ACESFilmicToneMapping, BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, DirectionalLight,
  Float32BufferAttribute, HemisphereLight, IcosahedronGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4,
  Mesh, MeshStandardNodeMaterial, Object3D, PCFShadowMap, PMREMGenerator, PerspectiveCamera, PlaneGeometry,
  PointLight, SRGBColorSpace, Scene, SphereGeometry, Vector3, WebGPURenderer, type Node, type NodeBuilder, type UniformNode,
} from 'three/webgpu'
import {
  Fn, attribute, exp, float, fog, max, mix, positionLocal, positionPrevious, positionView, positionWorld, select, sin, step,
  time, uniform, vec3,
} from 'three/tsl'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import { buildingMaterial, groundMaterial, waterMaterial } from './materials.ts'
import { CITY_CENTER, LAKE, generateBuildings, streetFurniture, type Box, type Furniture } from './city.ts'
import { FbmSet } from './fbmTexture.ts'
import { sunAt, type SunState } from './solar.ts'
import { regionMeshes, type RegionLayout, type RegionScene } from './region/regionWorld.ts'
import type { RegionPack } from './region/pack.ts'
import { SIGNAL } from '../02_Define_The_Rules/civic.ts'
import { applyCodeDissolve } from './codeDissolve.ts'

export class WebGPUUnavailableError extends Error {}

/**
 * The ink of a dissolving prop: the ghost view's pole green (ghost.ts GHOST_COLOR.pole, linear RGB). Stage 01 cannot
 * import stage 07, so the value is repeated here; dissolve.test.ts pins the two equal.
 */
export const PROP_DISSOLVE_INK: readonly [number, number, number] = Object.freeze([0.3, 0.95, 0.6] as [number, number, number])

/** The code dissolve's amounts, one float per instance of each prop mesh (0 solid, 1 gone): the engine writes them. */
export interface PropDissolve {
  lamps: InstancedBufferAttribute
  trees: InstancedBufferAttribute
  signals: InstancedBufferAttribute
}

export interface Gpu {
  renderer: WebGPURenderer
  device: GPUDevice
  adapterInfo: string
}

export async function createRenderer(canvas: HTMLCanvasElement, pixelRatio: number, profile = false): Promise<Gpu> {
  if (!('gpu' in navigator) || !navigator.gpu) throw new WebGPUUnavailableError('This browser does not expose WebGPU (navigator.gpu).')
  const renderer = new WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance', trackTimestamp: profile })
  await renderer.init()
  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean; device?: GPUDevice; adapter?: GPUAdapter }
  if (!backend.isWebGPUBackend || !backend.device) {
    renderer.dispose()
    throw new WebGPUUnavailableError('WebGPU adapter unavailable; three.js fell back to WebGL2, which cannot run the WGSL crowd.')
  }
  renderer.setPixelRatio(pixelRatio)
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.8
  renderer.outputColorSpace = SRGBColorSpace
  renderer.shadowMap.enabled = true
  // PCFSoftShadowMap was removed from three's WebGPU renderer; PCF with a blur radius replaces it.
  renderer.shadowMap.type = PCFShadowMap
  const info = backend.adapter?.info ?? (backend.device as GPUDevice & { adapterInfo?: GPUAdapterInfo }).adapterInfo
  const adapterInfo = info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' / ') : 'unknown adapter'
  return { renderer, device: backend.device, adapterInfo }
}

/** The GPUBuffer three created for an attribute. Valid after the attribute has been drawn once. */
export function gpuBufferOf(renderer: WebGPURenderer, attribute: BufferAttribute): GPUBuffer {
  const data = (renderer.backend as unknown as { get(o: object): { buffer?: GPUBuffer } }).get(attribute)
  if (!data.buffer) throw new Error(`three has not allocated a GPU buffer for "${attribute.name}" yet`)
  return data.buffer
}

/** Scale factors the Ring-0 operator may set on the lighting; the engine clamps them to LIGHT_TUNE_RANGE. */
export interface LightTuning {
  /** Aerial haze density. */
  haze: number
  /** Tone-mapping exposure. */
  exposure: number
  /** Direct sun / moon intensity. */
  sun: number
  /** Sky fill (hemisphere light and environment probe). */
  fill: number
}
export const LIGHT_TUNE_RANGE: Readonly<Record<keyof LightTuning, readonly [number, number]>> = {
  haze: [0, 4], exposure: [0.25, 3], sun: [0, 3], fill: [0, 3],
}

/**
 * How far the exposure comes down in daylight, stops: 0 at night, −log₂ 0.56 ≈ 0.84 in full daylight (ND 0.25).
 * The direct render path applies it through the renderer's tone-mapping exposure; the cinema camera applies it as
 * a variable neutral-density filter in its post chain (postfx.ts). Daylight is clamped to 0..1; NaN reads as night.
 */
export function ndStopsFor(daylight: number): number {
  const d = daylight > 0 ? Math.min(1, daylight) : 0
  return Math.log2(1 / (0.56 + 0.44 * (1 - d)))
}

export interface World {
  scene: Scene
  camera: PerspectiveCamera
  boxes: Box[]
  furniture: Furniture
  /** 0 by day, 1 at night: drives window, shop, lamp and signal-head emission. */
  night: UniformNode<'float', number>
  /** Seconds on the shared signal clock (drivers and pedestrians read the same value). */
  signalClock: UniformNode<'float', number>
  /** Sun by day, moon by night: the one shadow-casting light (quality.ts tunes its shadow map). */
  sun: DirectionalLight
  /** Procedural texture resolution, texels per edge: the largest resident size not above `size` (FBM_SIZES).
   *  A swap between textures uploaded at startup: no upload, no shader or pipeline rebuild, no hitch. */
  setTextureSize(size: number): void
  /** Operator tuning read every update(): scale factors (1 = the authored look). Bounds in LIGHT_TUNE_RANGE. */
  tuning: LightTuning
  /**
   * Instanced meshes whose instances update() re-orders (the buildings, sorted front to back for early-z): a slot's
   * previous matrix may be another instance's, so a motion-vector pass must not trust three's per-instance history
   * for them. They never move.
   */
  resorted: readonly InstancedMesh[]
  /**
   * Re-centres the sky on another camera before it draws (local split screen: each viewport's head). update() centres it
   * on `camera`; the sun, its shadow focus, the lamp lights and the building sort stay where update() put them.
   */
  follow(camera: PerspectiveCamera): void
  /** The region drawn instead of the procedural city (?region), with its counts; null for the city. */
  region: RegionScene | null
  /**
   * The code dissolve (codeDissolve.ts) of the props: per-instance amounts the engine writes when the user's body is
   * inside a lamp, a tree or a signal pole (instance i is furniture list index i). Empty in a region. View-only.
   * Buildings never dissolve: walls are solid by law.
   */
  dissolve: PropDissolve
  update(hours: number, signalSeconds: number, focusX: number, focusZ: number): SunState
}

/** Whether the pass being built writes motion vectors (three's builder knows; its typings leave the method out). */
const needsPrevious = (b: NodeBuilder): boolean => (b as NodeBuilder & { needsPreviousData(): boolean }).needsPreviousData()

/** Merges parts into one geometry with a per-vertex `part` id, so one material can shade them all. */
function assemble(parts: [BufferGeometry, number][]): BufferGeometry {
  const pos: number[] = [], nor: number[] = [], id: number[] = [], idx: number[] = []
  for (const [g, part] of parts) {
    const base = pos.length / 3
    const count = g.getAttribute('position').count
    pos.push(...(g.getAttribute('position').array as Float32Array))
    nor.push(...(g.getAttribute('normal').array as Float32Array))
    for (let i = 0; i < count; i++) id.push(part)
    if (g.index) for (const i of g.index.array) idx.push(base + i)
    else for (let i = 0; i < count; i++) idx.push(base + i)
    g.dispose()
  }
  const out = new BufferGeometry()
  out.setAttribute('position', new Float32BufferAttribute(pos, 3))
  out.setAttribute('normal', new Float32BufferAttribute(nor, 3))
  out.setAttribute('part', new Float32BufferAttribute(id, 1))
  out.setIndex(idx)
  return out
}

/** Matrices for [x, z, yaw-or-scale] entries. Trees pass `scaleOf` and get a pseudo-random yaw. */
function placed(list: [number, number, number][], scaleOf?: (e: [number, number, number]) => number): Matrix4[] {
  const o = new Object3D()
  return list.map((e) => {
    o.position.set(e[0], 0, e[1])
    o.rotation.set(0, scaleOf ? e[2] * 7.3 : e[2], 0)
    o.scale.setScalar(scaleOf ? scaleOf(e) : 1)
    o.updateMatrix()
    return o.matrix.clone()
  })
}

function instanced(geo: BufferGeometry, mat: MeshStandardNodeMaterial, matrices: Matrix4[], name: string): InstancedMesh {
  const mesh = new InstancedMesh(geo, mat, matrices.length)
  matrices.forEach((mx, i) => mesh.setMatrixAt(i, mx))
  mesh.computeBoundingSphere()
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.name = name
  return mesh
}

/** A fresh, all-solid dissolve attribute for `instances` slots. */
const dissolveAttribute = (instances: number): InstancedBufferAttribute => new InstancedBufferAttribute(new Float32Array(instances), 1)

function furnitureMeshes(f: Furniture, fbm: FbmSet, night: UniformNode<'float', number>, signalClock: UniformNode<'float', number>): { meshes: InstancedMesh[]; dissolve: PropDissolve } {
  const part = attribute('part', 'float')
  // The code dissolve: a per-instance amount, read by the helper in every stage; the origin is the instance's own
  // (positionLocal × 0, which the instance matrix maps to where the pole stands), so a gone prop folds to its foot.
  const dissolve: PropDissolve = { lamps: dissolveAttribute(f.lamps.length), trees: dissolveAttribute(f.trees.length), signals: dissolveAttribute(f.signals.length) }
  const amount = attribute('dissolve', 'float')
  const origin = positionLocal.mul(0)

  // Street lamps: pole, arm over the road, luminaire (part 1).
  const lampGeo = assemble([
    [new CylinderGeometry(0.06, 0.09, 6.2, 8).translate(0, 3.1, 0), 0],
    [new BoxGeometry(0.08, 0.08, 1.5).translate(0, 6.1, 0.72), 0],
    [new BoxGeometry(0.28, 0.1, 0.55).translate(0, 6.02, 1.4), 1],
  ])
  const lampMat = new MeshStandardNodeMaterial()
  lampMat.colorNode = select(part.greaterThan(0.5), vec3(0.9, 0.9, 0.85), vec3(0.16, 0.17, 0.18))
  lampMat.metalnessNode = float(0.6)
  lampMat.roughnessNode = float(0.45)
  lampMat.emissiveNode = vec3(1.0, 0.82, 0.55).mul(step(0.5, part).mul(night).mul(6))
  lampGeo.setAttribute('dissolve', dissolve.lamps)
  applyCodeDissolve(lampMat, amount, origin, PROP_DISSOLVE_INK)

  // Street trees: trunk (part 0) and a three-lobed canopy (part 1) that sways in the wind.
  const treeGeo = assemble([
    [new CylinderGeometry(0.12, 0.18, 3.2, 7).translate(0, 1.6, 0), 0],
    [new IcosahedronGeometry(1.6, 1).translate(0, 4.2, 0), 1],
    [new IcosahedronGeometry(1.2, 1).translate(0.9, 3.7, 0.3), 1],
    [new IcosahedronGeometry(1.1, 1).translate(-0.7, 3.9, -0.5), 1],
  ])
  const treeMat = new MeshStandardNodeMaterial()
  const leafTone = fbm.sample(positionWorld.xz.div(7)).r
  treeMat.colorNode = select(part.greaterThan(0.5), mix(vec3(0.12, 0.2, 0.07), vec3(0.24, 0.32, 0.1), leafTone), vec3(0.2, 0.15, 0.11))
  treeMat.roughnessNode = float(0.85)
  const sway = sin(time.mul(1.3).add(positionWorld.x.mul(0.21)).add(positionWorld.z.mul(0.17))).mul(0.07).mul(max(positionLocal.y.sub(2.5), 0))
  const swayed = vec3(sway, 0, sway.mul(0.6)).mul(step(0.5, part))
  treeMat.positionNode = Fn((builder: NodeBuilder) => {
    // A motion-vector pass sees the canopy where it sways now in both frames: the sway itself moves millimetres per
    // exposure, but a previous position without it would read the whole offset as motion.
    if (needsPrevious(builder)) positionPrevious.assign(positionPrevious.add(swayed))
    return positionLocal.add(swayed)
  })()
  treeGeo.setAttribute('dissolve', dissolve.trees)
  applyCodeDissolve(treeMat, amount, origin, PROP_DISSOLVE_INK)

  // Traffic signals: pole, head (part 1), and red / amber / green lenses (parts 2, 3, 4) facing local +z.
  const signalGeo = assemble([
    [new CylinderGeometry(0.08, 0.1, 5.0, 8).translate(0, 2.5, 0), 0],
    [new BoxGeometry(0.36, 1.05, 0.28).translate(0, 4.4, 0.1), 1],
    [new SphereGeometry(0.1, 10, 6).scale(1, 1, 0.4).translate(0, 4.75, 0.25), 2],
    [new SphereGeometry(0.1, 10, 6).scale(1, 1, 0.4).translate(0, 4.42, 0.25), 3],
    [new SphereGeometry(0.1, 10, 6).scale(1, 1, 0.4).translate(0, 4.09, 0.25), 4],
  ])
  signalGeo.setAttribute('signalAxis', new InstancedBufferAttribute(new Float32Array(f.signals.map((s) => s[3])), 1))
  const signalMat = new MeshStandardNodeMaterial()
  const ns = attribute('signalAxis', 'float').greaterThan(0.5)
  const ph = signalClock.mod(SIGNAL.cycle)
  const ewGreen = ph.lessThan(SIGNAL.ewGreen)
  const ewAmber = ph.greaterThanEqual(SIGNAL.ewGreen).and(ph.lessThan(SIGNAL.ewAmber))
  const nsGreen = ph.greaterThanEqual(SIGNAL.ewAmber).and(ph.lessThan(SIGNAL.nsGreen))
  const nsAmber = ph.greaterThanEqual(SIGNAL.nsGreen)
  const green = select(ns, nsGreen, ewGreen)
  const amber = select(ns, nsAmber, ewAmber)
  const red = green.or(amber).not()
  const lens = (id: number, on: Node<'bool'>, c: [number, number, number]) =>
    vec3(...c).mul(step(id - 0.5, part).mul(step(part, id + 0.5)).mul(select(on, float(9), float(0.04))))
  const isLens = part.greaterThan(1.5)
  signalMat.colorNode = select(isLens, vec3(0.05, 0.05, 0.05), select(part.greaterThan(0.5), vec3(0.03, 0.035, 0.03), vec3(0.2, 0.21, 0.2)))
  signalMat.roughnessNode = select(isLens, float(0.15), float(0.5))
  signalMat.metalnessNode = float(0.4)
  signalMat.emissiveNode = lens(2, red, [1.0, 0.08, 0.04]).add(lens(3, amber, [1.0, 0.55, 0.05])).add(lens(4, green, [0.1, 1.0, 0.45]))
  signalGeo.setAttribute('dissolve', dissolve.signals)
  applyCodeDissolve(signalMat, amount, origin, PROP_DISSOLVE_INK)

  const meshes = [
    instanced(lampGeo, lampMat, placed(f.lamps), 'StreetLamps'),
    instanced(treeGeo, treeMat, placed(f.trees, (e) => e[2]), 'StreetTrees'),
    instanced(signalGeo, signalMat, placed(f.signals.map((s) => [s[0], s[1], s[2]])), 'TrafficSignals'),
  ]
  return { meshes, dissolve }
}

/**
 * The world under its sky. With a region (a pack and where it sits), the region's surveyed buildings, streets and water
 * stand in for the procedural city: no city boxes, no street furniture, no city ground or lake.
 */
export function buildWorld(renderer: WebGPURenderer, seed: number, region: { pack: RegionPack; layout: RegionLayout } | null = null): World {
  const scene = new Scene()
  const camera = new PerspectiveCamera(62, 1, 0.1, 2400)
  const plan = region ? [] : generateBuildings(seed)
  const boxes = plan.map((b) => b.box)
  const furniture: Furniture = region ? { lamps: [], trees: [], signals: [] } : streetFurniture(seed)
  const night = uniform(0)
  const signalClock = uniform(0)

  const skyParams = { turbidity: 3.2, rayleigh: 1.6, mieCoefficient: 0.004, mieDirectionalG: 0.78, cloudCoverage: 0.32 }
  const makeSky = () => {
    const s = new SkyMesh()
    s.scale.setScalar(1000)
    for (const [k, v] of Object.entries(skyParams) as [keyof typeof skyParams, number][]) s[k].value = v
    s.frustumCulled = false
    return s
  }
  const sky = makeSky()
  sky.renderOrder = 2
  scene.add(sky)

  // Aerial perspective: exp² haze tinted by the sun's height, thinner with altitude.
  const hazeColor = uniform(new Color(0.62, 0.71, 0.82))
  const hazeDensity = uniform(0.0022)
  const heightFade = exp(positionWorld.y.max(0).mul(-0.006)).mul(0.7).add(0.3)
  const optical = hazeDensity.mul(heightFade).mul(positionView.z.negate())
  ;(scene as Scene & { fogNode: unknown }).fogNode = fog(hazeColor, float(1).sub(exp(optical.mul(optical).negate())))

  const envScene = new Scene()
  const envSky = makeSky()
  envScene.add(envSky)
  const pmrem = new PMREMGenerator(renderer)
  let envTarget: ReturnType<PMREMGenerator['fromScene']> | null = null
  let envHours = -99

  const hemi = new HemisphereLight(0xbfd4ea, 0x3a3530, 0.6)
  scene.add(hemi)
  const sun = new DirectionalLight(0xffffff, 3)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.radius = 1.5
  sun.shadow.bias = -0.0003
  sun.shadow.normalBias = 0.03
  const sc = sun.shadow.camera
  sc.left = -80; sc.right = 80; sc.top = 80; sc.bottom = -80; sc.near = 1; sc.far = 700
  scene.add(sun, sun.target)

  // One bake, every resolution the quality tiers use, all uploaded (with mips) before the first frame.
  const fbm = new FbmSet(seed)
  fbm.upload(renderer)
  const unit = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
  // Each box's finish (city.ts STYLE), per instance: it moves with its matrix when the instances are re-sorted.
  const styles = new InstancedBufferAttribute(new Float32Array(boxes.length), 1)
  unit.setAttribute('style', styles)
  const buildings = new InstancedMesh(unit, buildingMaterial(fbm, night), boxes.length)
  const matrices = boxes.map(([x0, y0, z0, x1, y1, z1]) => {
    const o = new Object3D()
    o.position.set((x0 + x1) / 2, y0, (z0 + z1) / 2)
    o.scale.set(x1 - x0, y1 - y0, z1 - z0)
    o.updateMatrix()
    return o.matrix.clone()
  })
  const order = boxes.map((_, i) => i)
  const centre = boxes.map(([x0, , z0, x1, , z1]) => [(x0 + x1) / 2, (z0 + z1) / 2])
  const sortedAt = { x: Infinity, z: Infinity }
  // One InstancedMesh is one draw, so three cannot depth-sort it. Re-ordering instances front to back
  // lets early-z reject hidden facades before their procedural fragment shading runs.
  const sortBuildings = (x: number, z: number) => {
    if (Math.hypot(x - sortedAt.x, z - sortedAt.z) < 6) return
    sortedAt.x = x
    sortedAt.z = z
    const d = centre.map(([cx, cz]) => (cx - x) ** 2 + (cz - z) ** 2)
    order.sort((a, b) => d[a] - d[b])
    order.forEach((box, slot) => {
      buildings.setMatrixAt(slot, matrices[box])
      styles.setX(slot, plan[box].style)
    })
    buildings.instanceMatrix.needsUpdate = true
    styles.needsUpdate = true
  }
  sortBuildings(CITY_CENTER, CITY_CENTER)
  buildings.computeBoundingSphere()
  buildings.castShadow = true
  buildings.receiveShadow = true
  buildings.name = 'Buildings'
  if (!region) scene.add(buildings)
  const regionScene = region ? regionMeshes(region.pack, region.layout, fbm, night) : null
  if (regionScene) for (const m of regionScene.meshes) scene.add(m)

  // The ground stops at the seawall; the lake takes over from there (never water over ground: at a distance the
  // two would fight for the depth buffer).
  const south = CITY_CENTER - 1600, north = CITY_CENTER + 1600
  const landDepth = LAKE.shore + LAKE.wall.thickness - south
  const ground = new Mesh(new PlaneGeometry(3200, landDepth).rotateX(-Math.PI / 2).translate(CITY_CENTER, 0, south + landDepth / 2), groundMaterial(fbm, night))
  ground.receiveShadow = true
  ground.renderOrder = 1
  ground.name = 'Streets'
  if (!region) scene.add(ground)
  const lakeDepth = north - (LAKE.shore + LAKE.wall.thickness)
  const lake = new Mesh(new PlaneGeometry(3200, lakeDepth).rotateX(-Math.PI / 2).translate(CITY_CENTER, LAKE.water, north - lakeDepth / 2), waterMaterial(fbm))
  lake.receiveShadow = true
  lake.name = 'Lake'
  // A region has no street furniture: its dissolve attributes are empty (nothing to write, nothing drawn).
  let dissolve: PropDissolve = { lamps: dissolveAttribute(0), trees: dissolveAttribute(0), signals: dissolveAttribute(0) }
  if (!region) {
    scene.add(lake)
    const props = furnitureMeshes(furniture, fbm, night, signalClock)
    for (const mesh of props.meshes) scene.add(mesh)
    dissolve = props.dissolve
  }

  // Real light from the lamps nearest the player, so people, cars and facades are lit after dark
  // (the rest of the lamps are emissive only). Always present, so dusk never triggers a recompile.
  const lampLights = Array.from({ length: 6 }, () => {
    const l = new PointLight(0xffd6a0, 0, 24, 2)
    scene.add(l)
    return l
  })
  const lampHeads = furniture.lamps.map(([x, z, yaw]) => [x + Math.sin(yaw) * 1.4, 5.9, z + Math.cos(yaw) * 1.4])
  const nearest: number[] = []
  const placeLampLights = (fx: number, fz: number, nightness: number) => {
    nearest.length = 0
    if (!lampHeads.length) return
    const d = lampHeads.map(([x, , z]) => (x - fx) ** 2 + (z - fz) ** 2)
    for (let n = 0; n < lampLights.length; n++) {
      let best = -1
      for (let i = 0; i < d.length; i++) if (!nearest.includes(i) && (best < 0 || d[i] < d[best])) best = i
      nearest.push(best)
      const [x, y, z] = lampHeads[best]
      lampLights[n].position.set(x, y, z)
      lampLights[n].intensity = 40 * nightness
    }
  }

  const warm = new Color(1.0, 0.62, 0.36)
  const white = new Color(1.0, 0.97, 0.92)
  const moon = new Color(0.55, 0.64, 0.85)
  const dayHaze = new Color(0.66, 0.74, 0.84)
  const duskHaze = new Color(0.86, 0.66, 0.5)
  // Night haze carries a faint city glow so the skyline never sits on pure black.
  const nightHaze = new Color(0.03, 0.036, 0.052)
  const tmp = new Color()
  const lightDir = new Vector3()
  const tuning: LightTuning = { haze: 1, exposure: 1, sun: 1, fill: 1 }

  const update = (hours: number, signalSeconds: number, focusX: number, focusZ: number): SunState => {
    const s = sunAt(hours)
    const day = s.daylight
    night.value = 1 - day
    signalClock.value = signalSeconds
    sky.sunPosition.value.set(s.x, s.y, s.z)
    sky.position.copy(camera.position)

    // Low sun is warm; below the horizon a dim, cool moon lights the city from the opposite sky.
    const golden = Math.max(0, Math.min(1, s.elevationDeg / 25))
    // As the sun drops the sky fill falls faster than the direct beam, which is what makes golden-hour
    // shadows (the city's and your own) long and legible. Both factors are 1 from 25° up (noon unchanged), and the
    // fill cut fades out with daylight (nights unchanged).
    const fill = 1 - 0.45 * (1 - golden) * day
    if (s.elevationDeg > -2) {
      lightDir.set(s.x, Math.max(s.y, 0.04), s.z).normalize()
      sun.color.copy(warm).lerp(white, golden)
      sun.intensity = 3.0 * day * (1 + 0.8 * (1 - golden)) * tuning.sun
    } else {
      lightDir.set(-s.x, Math.max(-s.y, 0.25), -s.z).normalize()
      sun.color.copy(moon)
      sun.intensity = 0.22 * tuning.sun
    }
    hemi.intensity = (0.04 + 0.16 * day) * fill * tuning.fill
    hemi.color.setRGB(0.1, 0.14, 0.22).lerp(tmp.setRGB(0.75, 0.83, 0.92), day)
    hemi.groundColor.setRGB(0.03, 0.03, 0.035).lerp(tmp.setRGB(0.24, 0.22, 0.2), day)
    hazeColor.value.copy(nightHaze).lerp(tmp.copy(duskHaze).lerp(dayHaze, golden), day)
    hazeDensity.value = (0.0022 + 0.0012 * (1 - day)) * tuning.haze
    renderer.toneMappingExposure = 2 ** -ndStopsFor(day) * tuning.exposure

    // Refresh the environment probe as the light changes (about every 12 game minutes).
    if (Math.abs(hours - envHours) > 0.2) {
      envHours = hours
      envSky.sunPosition.value.set(s.x, s.y, s.z)
      const next = pmrem.fromScene(envScene, 0.02)
      scene.environment = next.texture
      envTarget?.dispose()
      envTarget = next
    }
    scene.environmentIntensity = (0.12 + 0.28 * day) * fill * tuning.fill
    placeLampLights(focusX, focusZ, 1 - day)

    if (!region) sortBuildings(focusX, focusZ)
    // Snap to whole shadow texels so shadows do not crawl; the map size changes with the quality tier.
    const texel = (sc.right - sc.left) / sun.shadow.mapSize.x
    const sx = Math.round(focusX / texel) * texel
    const sz = Math.round(focusZ / texel) * texel
    sun.target.position.set(sx, 0, sz)
    sun.position.set(sx + lightDir.x * 320, lightDir.y * 320, sz + lightDir.z * 320)
    return s
  }

  const setTextureSize = (size: number) => { fbm.setSize(size) }
  const follow = (other: PerspectiveCamera) => { sky.position.copy(other.position) }

  return { scene, camera, boxes, furniture, night, signalClock, sun, setTextureSize, tuning, resorted: region ? [] : [buildings], follow, region: regionScene, dissolve, update }
}
