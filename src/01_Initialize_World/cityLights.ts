// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the city's night lighting: real light from every street lamp near the player and
 * from the ceiling fixtures of every indoor workplace, through three r186's clustered (Forward+) lighting, so a
 * street after dark is lit by its lamps and a room by its ceiling, on the city map and on a region's street window
 * alike (a region's asphalt had no painted lamp pools, and its lamps lit nothing: the street under them was dark).
 *
 * three's default lighting puts every point light into every lit material's shader (one uniform block and one
 * loop body per light), so the light count is part of each pipeline's key: six lamps were all the page could afford,
 * and adding one recompiled the city. Clustered lighting (three/addons ClusteredLighting) keeps the point lights in
 * a texture, bins them once a frame into a grid of view-frustum cells with a compute pass, and each fragment loops over
 * the few lights of its own cell: the count is a uniform, the shader is the same for six lamps or four hundred, and a
 * tier change moves the count without a recompile. The grid here is held constant (CityLightsNode): three's node
 * re-creates its compute pass whenever the drawing buffer changes size, which re-keys every lit material, and the
 * quality governor changes the drawing buffer's size at every tier step. With a fixed count of tiles across and down,
 * a tile is simply the drawing buffer divided by that count (one uniform), the compute pass is built once, and nothing
 * recompiles on a resize or a tier change (the same promise quality.ts keeps for everything else it touches).
 *
 * Also here, pure and tested: which lamps are lit (the nearest to the focus, as many as the tier allows: nearestLamps),
 * the fixtures of a room (roomFixtures) and the lamp and fixture photometry (LAMP, FIXTURE).
 * What breaks if it is removed? The street lamps are emissive heads over a dark street, the rooms are lit by the sky
 * alone, and the sixth lamp is the last one the city can light.
 */
import { Lighting, Vector2, type LightsNode, type Scene, type WebGPURenderer } from 'three/webgpu'
import ClusteredLightsNode from 'three/addons/tsl/lighting/ClusteredLightsNode.js'
import {
  Fn, If, Loop, Return, attributeArray, clamp, dot, float, instanceIndex, int, ivec2, ivec4, log, max, min, positionView, pow,
  textureLoad, vec2, vec3, viewportCoordinate, viewportSize,
} from 'three/tsl'
import type { Node, UniformNode } from 'three/webgpu'
import { ROOM, toWorld, type Workplace } from './interiors.ts'

/**
 * The cluster grid: tiles across and down the drawing buffer (whatever its size: 40 px tiles at 1080p, 20 px at a
 * phone's half scale, 100 px at Peak's 4K), and the depth slices between the camera's near and far planes, spaced
 * exponentially as three spaces them. 48 × 27 × 24 = 31,104 cells; at LIGHT_GRID.perCluster lights a cell the index
 * buffer is 4 MB. A lamp lights 28 m around it (LAMP.range) and lamps stand 20 m apart along both kerbs, so a cell
 * near the street sees ten to fifteen lamps; the room fixtures add four. A cell that overflows drops the lights past
 * its capacity, so the capacity is twice the dense case.
 */
export const LIGHT_GRID = Object.freeze({ x: 48, y: 27, z: 24, perCluster: 32 })

/** The most point lights the clustered node holds: FULL_WORLD's lamp pool and every room's fixtures. */
export const MAX_CLUSTERED_LIGHTS = 512

/**
 * A street lamp's light (the pole, arm and head are world.ts furnitureMeshes'): the luminaire's height and reach over
 * the kerb (where the head is), its intensity in candela at full night, its cut-off range and the warm colour of the
 * head's emissive. The night is drawn at nearly the day's exposure (world.ts ndStopsFor: 0.84 stops apart, where the
 * real sky and a real street lamp are twelve apart), so a lamp here is a small fraction of the sun's 3: 28 cd lights
 * the asphalt under the pole to about a third of the painted pool's brightness (materials.ts lampPool) and a pale
 * facade a kerb away to a soft glow; 80 cd (tried first) drew the street as if by day.
 */
export const LAMP = Object.freeze({ height: 5.9, reach: 1.4, candela: 28, range: 28, decay: 2, color: [1.0, 0.82, 0.55] as const })

/** Where a room's four fixtures hang on each axis of the room's (u, v) frame, m: the centre of each quarter. */
const FIXTURE_SPAN = 6.5

/**
 * A room's ceiling fixtures (interiors.ts rooms are 26 m square under a 4.2 m ceiling): four lights in the room's
 * frame, hung just under the slab, always on (a workplace is lit by day and by night), cool office white. The emissive
 * panels the ceiling shows (materials.ts buildingMaterial) are the fixtures' faces, drawn over the same four points
 * (a lot's centre is at (k + 0.5) × CITY.pitch on both axes, in the city and in a region's street window, and the
 * four points are the same set whichever way the door faces); these are their light. 18 cd lights the floor under a
 * fixture to about the night street's brightness and leaves the ceiling round the fixture a glowing halo.
 */
export const FIXTURE = Object.freeze({
  span: FIXTURE_SPAN,
  at: Object.freeze([[-FIXTURE_SPAN, -FIXTURE_SPAN], [-FIXTURE_SPAN, FIXTURE_SPAN], [FIXTURE_SPAN, -FIXTURE_SPAN], [FIXTURE_SPAN, FIXTURE_SPAN]] as const),
  /** Hung this far under the ceiling, m: a pendant, so the ceiling round it is lit rather than grazed (a light a hand
   *  under the slab lit a blown-out spot and left the rest of the ceiling dark). */
  drop: 0.6,
  /** The emissive panel's half-width on the ceiling, m. */
  panel: 0.6,
  candela: 18,
  range: 18,
  decay: 2,
  color: [0.95, 0.97, 1.0] as const,
})

/** A light's place and brightness for the world to set on a PointLight. */
export interface Fixture { x: number; y: number; z: number; candela: number; range: number; decay: number; color: readonly [number, number, number] }

/** Every room's fixtures (FIXTURE.at, rotated into the city by the room's door side), in room order. */
export function roomFixtures(rooms: readonly Pick<Workplace, 'cx' | 'cz' | 'side'>[]): Fixture[] {
  const out: Fixture[] = []
  for (const room of rooms) {
    for (const [u, v] of FIXTURE.at) {
      const p = toWorld(room, u, v)
      out.push({ x: p.x, y: ROOM.height - FIXTURE.drop, z: p.z, candela: FIXTURE.candela, range: FIXTURE.range, decay: FIXTURE.decay, color: FIXTURE.color })
    }
  }
  return out
}

/** A lamp head's place over its pole ([x, z, yaw] as city.ts streetFurniture lists lamps): the arm reaches `yaw`-ward. */
export function lampHead([x, z, yaw]: readonly [number, number, number]): [number, number, number] {
  return [x + Math.sin(yaw) * LAMP.reach, LAMP.height, z + Math.cos(yaw) * LAMP.reach]
}

/**
 * The indices of the `count` lamp heads nearest (fx, fz), nearest first, into `out` (whose length is set to what was
 * found: fewer when there are fewer heads). `d2` is scratch for the squared distances (one float per head) and
 * `order` scratch for the sort (one index per head); both are grown when too short. Pure: nothing of the lights.
 * Returns the squared distance of the farthest lamp chosen (0 with none): the radius the real light reaches.
 */
export function nearestLamps(heads: readonly (readonly [number, number, number])[], fx: number, fz: number, count: number, out: number[], scratch: { d2: Float32Array; order: Uint32Array }): number {
  const n = heads.length
  const want = Math.max(0, Math.min(count, n))
  out.length = 0
  if (want === 0) return 0
  if (scratch.d2.length < n) scratch.d2 = new Float32Array(n)
  if (scratch.order.length < n) scratch.order = new Uint32Array(n)
  const d2 = scratch.d2
  const order = scratch.order.subarray(0, n)
  for (let i = 0; i < n; i++) {
    const h = heads[i]
    const dx = h[0] - fx, dz = h[2] - fz
    d2[i] = dx * dx + dz * dz
    order[i] = i
  }
  order.sort((a, b) => d2[a] - d2[b])
  for (let k = 0; k < want; k++) out.push(order[k])
  return d2[order[want - 1]]
}

/** The parts of three's clustered node this file drives that its typings leave out. */
interface ClusteredInternals {
  _chunksPerCluster: number
  _bufferSize: Vector2 | null
  _lightIndexes: unknown
  _screenClusterIndex: unknown
  _compute: unknown
  _cameraNear: UniformNode<'float', number>
  _cameraFar: UniformNode<'float', number>
  _cameraProjectionMatrix: { element(i: number): { element(j: number): F } }
  _zSliceRangesTexture: Parameters<typeof textureLoad>[0]
  getLightData(index: I): { viewPosition: V3; distance: F }
}

type I = Node<'int'>
type F = Node<'float'>
type V3 = Node<'vec3'>
/** three's TSL typings keep int and uint apart; its clustered node mixes them as WGSL lets it, and so does this one. */
const asInt = (n: unknown): I => n as I

/**
 * three's clustered lights node with a constant grid. three's `create()` bakes the tile counts of the drawing buffer's
 * size into its compute pass and rebuilds the pass on a resize, which changes every lit material's cache key; here
 * the counts are LIGHT_GRID's whatever the size, the pass is built once in the constructor, and a fragment finds its
 * tile from its place in the viewport (three's viewportCoordinate and viewportSize, uniforms the renderer sets every
 * render), so nothing recompiles on a resize or a tier change, and a split-screen viewport or a render target gets
 * its own grid over its own rectangle (the compute pass runs once per render, with that render's camera). The compute
 * pass is otherwise three's: one thread per cell, the cell's view-space box against each light's sphere over the
 * lights that reach its depth slice.
 */
export class CityLightsNode extends ClusteredLightsNode {
  readonly grid: typeof LIGHT_GRID

  constructor(grid: typeof LIGHT_GRID = LIGHT_GRID, maxLights = MAX_CLUSTERED_LIGHTS) {
    super(maxLights, 1, grid.z, grid.perCluster)
    this.grid = grid
    this.buildGrid(grid.x, grid.y, grid.z)
  }

  /** three's per-render and per-build hook (its typings leave it out), which sizes its grid to the drawing buffer:
   *  the grid here is constant, so there is nothing to do. */
  updateProgram(): void {}

  /** three's resize hook: the grid is constant, so there is nothing to rebuild. */
  override setSize(_width?: number, _height?: number): this {
    return this
  }

  /** Builds the index buffer, the compute pass and the fragment's cell lookup once, for a grid of NX × NY × NZ cells. */
  private buildGrid(NX: number, NY: number, NZ: number): void {
    const self = this as unknown as ClusteredInternals
    const chunksPerCluster = self._chunksPerCluster
    const clusterCount = NX * NY * NZ
    const lightIndexes = attributeArray(new Int32Array(clusterCount * chunksPerCluster * 4), 'ivec4').setName('lightIndexes')
    type Chunk = Node<'ivec4'> & { element(i: I): I }
    const chunk = (i: I): Chunk => lightIndexes.element(i) as unknown as Chunk
    const maxLightsPerCluster = this.maxLightsPerCluster
    const invocation = asInt(instanceIndex)
    const slot = (slotIdx: I): I => {
      const stride = int(4)
      const idx = invocation.mul(int(chunksPerCluster)).add(slotIdx.div(stride))
      return asInt(chunk(idx).element(slotIdx.mod(stride)))
    }
    const compute = Fn(() => {
      // View-space extent per unit of NDC at a depth: the projection's focal terms.
      const invFocalX = float(1).div(self._cameraProjectionMatrix.element(0).element(0))
      const invFocalY = float(1).div(self._cameraProjectionMatrix.element(1).element(1))
      const cx = invocation.mod(NX)
      const cy = invocation.div(NX).mod(NY)
      const cz = invocation.div(NX * NY)
      // The cell's NDC bounds; y is flipped (row 0 is the top of the screen, NDC y = +1).
      const ndcXmin = float(cx).mul(2.0 / NX).sub(1.0)
      const ndcXmax = float(cx.add(int(1))).mul(2.0 / NX).sub(1.0)
      const ndcYmax = float(1).sub(float(cy).mul(2.0 / NY))
      const ndcYmin = float(1).sub(float(cy.add(int(1))).mul(2.0 / NY))
      // The cell's view-space depth bounds (negative; exponential slices).
      const farOverNear = self._cameraFar.div(self._cameraNear)
      const zNear = self._cameraNear.mul(pow(farOverNear, float(cz).mul(1.0 / NZ))).negate()
      const zFar = self._cameraNear.mul(pow(farOverNear, float(cz.add(int(1))).mul(1.0 / NZ))).negate()
      const xMinNear = ndcXmin.mul(zNear.negate().mul(invFocalX)), xMaxNear = ndcXmax.mul(zNear.negate().mul(invFocalX))
      const xMinFar = ndcXmin.mul(zFar.negate().mul(invFocalX)), xMaxFar = ndcXmax.mul(zFar.negate().mul(invFocalX))
      const yMinNear = ndcYmin.mul(zNear.negate().mul(invFocalY)), yMaxNear = ndcYmax.mul(zNear.negate().mul(invFocalY))
      const yMinFar = ndcYmin.mul(zFar.negate().mul(invFocalY)), yMaxFar = ndcYmax.mul(zFar.negate().mul(invFocalY))
      // The box round the cell's eight corners (a cell can straddle the view axis).
      const aabbMin = vec3(min(xMinNear, xMinFar), min(yMinNear, yMinFar), zFar)
      const aabbMax = vec3(max(xMaxNear, xMaxFar), max(yMaxNear, yMaxFar), zNear)
      // Last frame's list cleared.
      Loop(chunksPerCluster, ({ i }: { i: I }) => {
        chunk(invocation.mul(int(chunksPerCluster)).add(asInt(i))).assign(ivec4(0))
      })
      const index = int(0).toVar()
      // Only the lights that reach this cell's depth slice (the node sorts them by depth and uploads the ranges).
      const zRange = textureLoad(self._zSliceRangesTexture, ivec2(cz, 0))
      const rangeStart = int(zRange.x)
      const rangeEnd = int(zRange.y)
      Loop(this.maxLights, ({ i }: { i: I }) => {
        const lightIdx = rangeStart.add(asInt(i))
        If(index.greaterThanEqual(int(maxLightsPerCluster)).or(lightIdx.greaterThanEqual(rangeEnd)), () => {
          Return()
        })
        const { viewPosition, distance } = self.getLightData(lightIdx)
        // The light's sphere against the cell's box, in view space.
        const closest = max(aabbMin, min(viewPosition, aabbMax))
        const diff = viewPosition.sub(closest)
        If(dot(diff, diff).lessThanEqual(distance.mul(distance)), () => {
          slot(index).assign(lightIdx.add(int(1)))
          index.addAssign(int(1))
        })
      })
    })().compute(clusterCount).setName('Update City Lights')
    // The fragment's cell: its tile from its place in the viewport, its slice from its view depth.
    const screenClusterIndex = Fn(() => {
      const tile = viewportCoordinate.mul(vec2(NX, NY)).div(viewportSize).floor()
      const tx = int(clamp(tile.x, float(0), float(NX - 1)))
      const ty = int(clamp(tile.y, float(0), float(NY - 1)))
      const viewDepth = positionView.z.negate()
      const invLogFarOverNear = float(1).div(log(self._cameraFar.div(self._cameraNear)))
      const sliceFloat = log(viewDepth.div(self._cameraNear)).mul(invLogFarOverNear).mul(float(NZ))
      const zSlice = clamp(sliceFloat.floor(), float(0), float(NZ - 1))
      return tx.add(ty.mul(int(NX))).add(int(zSlice).mul(int(NX * NY)))
    })().toVar()
    self._bufferSize = new Vector2(NX, NY)
    self._lightIndexes = lightIndexes
    self._screenClusterIndex = screenClusterIndex
    self._compute = compute
  }
}

/**
 * The page's lighting system: the city's scene gets the clustered node (its lamps and fixtures bin into the grid, the
 * sun and the sky fill stay three's built-in path), every other scene (the sky probe's, ghost view's) three's default
 * node, so no other scene pays for a grid it has no lights for. Set on the renderer before anything compiles
 * (world.ts buildWorld); the shadow-shader test builds its offline renderer the same way.
 */
export class CityLighting extends Lighting {
  private readonly city: Scene
  private node: CityLightsNode | null = null

  constructor(city: Scene) {
    super()
    this.city = city
  }

  override getNode(scene: Scene): LightsNode {
    if (scene !== this.city) return super.getNode(scene)
    if (this.node === null) this.node = new CityLightsNode()
    return this.node
  }
}

/** Puts the city's clustered lighting on the renderer for `city`'s scene. Returns the lighting, for tests. */
export function clusterCityLights(renderer: WebGPURenderer, city: Scene): CityLighting {
  const lighting = new CityLighting(city)
  renderer.lighting = lighting
  return lighting
}
