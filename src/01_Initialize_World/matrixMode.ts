// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Matrix mode, the page's half: the global state of globalState.ts (x = time, y = matrix
 * mode, z and w = the floating origin) as three's vec4 uniform, set once a frame from the shared clock, the mode and
 * the camera (createMatrixMode) and read by every material that takes the mode; and applyMatrixMode, the TSL helper
 * any MeshStandardNodeMaterial takes, which calls the WGSL surface (matrixMesh.wgsl) with the fragment's world
 * position, geometric normal and the material's own base colour, and routes its answer into the colour (dimmed to
 * nothing: the surface is unlit, as the shader writes it) and the emissive (the code's glow). The same state goes to
 * the crowd's compute passes through 03_Spawn_Agents/crowdCompute.ts (the cull packs this page's state, the physics
 * worker's simulation packs the mode it was told), so the two pipelines cannot disagree.
 * - Stage 01 so the world's props (world.ts), the fleet (07_Execute_Actions/fleetView.ts) and the crowd
 *   (03_Spawn_Agents/crowd.ts) can all take it; it imports only three.
 * - Pure: it builds nodes and never needs a renderer, so the graph is tested under Node.
 * What breaks if it is removed? The materials have no matrix mode, the crowd's Params has no global word, and the
 * console's `matrix` knob and the M key drive nothing.
 */
import { Vector4 } from 'three/webgpu'
import type { MeshStandardNodeMaterial, Node, UniformNode } from 'three/webgpu'
import { float, materialColor, normalWorldGeometry, positionWorld, uniform, vec3, wgslFn } from 'three/tsl'
import source from './matrixMesh.wgsl?raw'
import { floatingOrigin, type GlobalState } from './globalState.ts'

/** A finite number, or `fallback`. */
const finite = (x: number, fallback: number): number => (Number.isFinite(x) ? x : fallback)

/** The mode on the page: the materials' uniform and the state the crowd's passes receive. */
export interface MatrixMode {
  /** The vec4 uniform every material reads (applyMatrixMode). */
  readonly globalState: UniformNode<'vec4', Vector4>
  /** The state as last set: what the crowd's cull packs, and the physics realm is told the mode of. */
  readonly state: GlobalState
  /** Whether the mode is on (what set() was last told). */
  readonly on: boolean
  /** One presented frame: the shared clock, the mode and the camera the origin is anchored to. */
  set(time: number, on: boolean, cameraX: number, cameraZ: number): void
}

export function createMatrixMode(): MatrixMode {
  const globalState = uniform(new Vector4(0, 0, 0, 0))
  const state: GlobalState = { time: 0, on: false, originX: 0, originZ: 0 }
  return {
    globalState,
    state,
    get on() { return state.on },
    set(time, on, cameraX, cameraZ) {
      const o = floatingOrigin(cameraX, cameraZ)
      state.time = finite(time, 0)
      state.on = on === true
      state.originX = o.x
      state.originZ = o.z
      globalState.value.set(state.time, state.on ? 1 : 0, o.x, o.z)
    },
  }
}

// The WGSL file holds the hash and the surface as two functions; wgslFn takes one function per call and the others
// as includes, so the source is split at each function's `fn`.
const [randomSource, surfaceSource] = source.split(/(?=^fn matrixSurface)/m)
const matrixRandom = wgslFn(randomSource)
const matrixSurface = wgslFn(surfaceSource, [matrixRandom] as unknown as Parameters<typeof wgslFn>[1])

/** What applyMatrixMode last set on each material: the colour it left and the uniform it read. */
const applied = new WeakMap<MeshStandardNodeMaterial, { colour: Node; globalState: UniformNode<'vec4', Vector4> }>()

/**
 * Gives `material` matrix mode: with the uniform's y at 1 the fragment is the surface matrixMesh.wgsl computes from
 * its world position and geometric normal (the code's glow and a tenth of the base colour), unlit, so it goes to
 * emissiveNode and the colour the lights act on is dimmed to nothing; the existing emissive (a lamp's head, a
 * window) is dimmed with it. With y at 0 the material is exactly as it was: the surface returns the base colour and
 * an alpha of 0, and every mix below is the identity. Roughness, metalness, normal and position are untouched; the
 * code dissolve (codeDissolve.ts) is applied after this, over it. Returns the same material.
 * The mode is the material's, however many meshes share it: asked again for a material it already gave the mode
 * from the same uniform (its colour still the one set here), it changes nothing. Each wrap reads the colour under it
 * twice (the dimmed colour and the surface's base), so wraps stacked one per mesh made the shadow pass's shader four
 * times longer per wrap, which no browser can build past about twenty (a region's buildings: one facade, every tile).
 */
export function applyMatrixMode(material: MeshStandardNodeMaterial, globalState: UniformNode<'vec4', Vector4>): MeshStandardNodeMaterial {
  const done = applied.get(material)
  if (done && done.colour === material.colorNode && done.globalState === globalState) return material
  const base = vec3((material.colorNode ?? materialColor) as Node<'vec3'>)
  const surface = matrixSurface(positionWorld, normalWorldGeometry, base, globalState) as unknown as Node<'vec4'>
  const on = surface.a
  const off = float(1).sub(on)
  material.colorNode = base.mul(off)
  const existing = material.emissiveNode as Node<'vec3'> | null
  const glow = surface.rgb.mul(on)
  material.emissiveNode = existing ? vec3(existing).mul(off).add(glow) : glow
  applied.set(material, { colour: material.colorNode, globalState })
  return material
}
