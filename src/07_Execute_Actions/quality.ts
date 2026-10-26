// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It turns a quality tier into renderer state, touching only what changed and
 * only through mechanisms three r186's WebGPU renderer absorbs without rebuilding pipelines:
 * - Render scale: renderer.setPixelRatio() resizes the canvas drawing buffer only (CSS size untouched);
 *   the post pass, bloom and FXAA follow the drawing-buffer size each frame. Same path as a window resize.
 * - Render scale above 1 (Peak): the same setPixelRatio, held so the drawing buffer's longer edge stays within the
 *   device's largest 2D texture (pixelRatioFor); a window resize refits it (refitPixelRatio).
 * - Sun shadow box (Peak): the shadow camera's left/right/top/bottom and its projection, which three's ShadowNode
 *   computes only at setup, so applyShadowExtent recomputes it (a uniform; nothing recompiles).
 * - Shadow map size: ShadowNode.renderShadow() calls shadowMap.setSize(mapSize) before every shadow render,
 *   so a new mapSize reallocates the depth target on the next shadow pass; the PCF filter reads mapSize as
 *   a uniform and bind groups are rebuilt when the texture is replaced. No shader changes.
 * - Shadows off/on: renderer.shadowMap.enabled is part of every render object's dynamic cache key, and
 *   light.castShadow is part of the lights cache key, so flipping either rebuilds every lit pipeline (a
 *   visible hitch, again on the way back). Once the shadowed variant exists, shadows are instead parked:
 *   shadow.intensity = 0 (a uniform: fully lit), shadow.autoUpdate = false (the shadow pass is skipped),
 *   and shadow.needsUpdate with a 16² map releases the full-size depth target (the resize bumps the depth
 *   texture's version, so ShadowNode renders the tiny map twice, then stops). The first application (no `prev`)
 *   decides whether the shadowed variant is compiled at all, so a device that starts without shadows
 *   never pays for them; turning them on later compiles that variant once.
 * - Procedural texture resolution: the world swaps the one TextureNode every city material samples through
 *   between FBM textures uploaded (with mips) at startup. Each draw's texture binding notices the new
 *   texture and gets a bind group for it (cached per texture); material cache keys ignore node values and
 *   the layout depends only on format and dimension, so nothing recompiles and nothing uploads (fbmTexture.ts).
 * - Post and crowd culling (the GPU density lottery and draw distance) are delegated to the engine
 *   (render path switch, compute uniform).
 * - Golden-hour volumetrics (Ultra and Peak): a strength uniform the engine writes (volumetrics.ts). The ray
 *   loop in the post chain is gated by that uniform, so the shader is compiled once with the pipeline and a
 *   tier change flips one float: no recompile either way.
 * All of it is silent: no toast, no HUD notice; the terminal's `quality` command shows the tier.
 * What breaks if it is removed? The governor's tier changes and the terminal's `quality` command have no
 * visible effect, and the start tier chosen for a phone is never applied.
 */
import type { DirectionalLight, WebGPURenderer } from 'three/webgpu'
import type { QualityKnobs } from '../05_Observe_Environment/governor.ts'

export interface QualityTargets {
  renderer: WebGPURenderer
  sun: DirectionalLight
  /** Pixel ratio at renderScale 1. */
  basePixelRatio: number
  setCrowd(c: { lodDistance: number; nearRadius: number; density: number; maxDistance: number }): void
  setPost(on: boolean): void
  /** Sun shafts in the post chain: Volumetrics.strength 1 or 0 (a uniform; nothing recompiles). Only
   *  ever true together with `post`. */
  setVolumetrics(on: boolean): void
  /** Procedural (FBM) texture resolution, texels per edge: World.setTextureSize. */
  setTextureSize(size: number): void
  /** The drawing buffer's limit: its longer edge stays within maxEdge texels (the device's maxTextureDimension2D) for a
   *  canvas cssEdge() CSS pixels on its longer side. Absent: no limit (the tests' mock). */
  fit?: { maxEdge: number; cssEdge(): number }
}

/** Shadow map edge while shadows are parked. */
export const PARKED_SHADOW_MAP = 16

/** Half-width of the sun's shadow box below Peak, m: the box world.ts builds (peakWiring.test.ts pins the two together). */
export const SHADOW_EXTENT = 80

/** Pure. The pixel ratio for a render scale, lowered only as far as keeps the drawing buffer's longer edge within maxEdge
 *  texels (WebGPU's default 8192 here: the device asks no limits). A cssEdge under 1 reads as 1. */
export function pixelRatioFor(base: number, scale: number, cssEdge: number, maxEdge = Infinity): number {
  return Math.min(base * scale, maxEdge / Math.max(1, cssEdge))
}
const ratioOf = (k: QualityKnobs, t: QualityTargets): number => pixelRatioFor(t.basePixelRatio, k.renderScale, t.fit?.cssEdge() ?? 1, t.fit?.maxEdge)
const extentOf = (k: QualityKnobs): number => k.shadowExtent ?? SHADOW_EXTENT

/** After a resize (engine.ts resize): the ratio again for the canvas's new size, set only when it moved (the limit
 *  engaged or let go). */
export function refitPixelRatio(k: QualityKnobs, t: QualityTargets): void {
  const r = ratioOf(k, t)
  if (t.renderer.getPixelRatio() !== r) t.renderer.setPixelRatio(r)
}

/** Shadow intensity before parking, restored on the way back (1 unless someone tuned it). */
const parkedIntensity = new WeakMap<object, number>()

/** Call once without `prev` before the scene is first compiled, then with the previously applied knobs
 *  on every change. Only fields that differ from `prev` are applied. */
export function applyQuality(k: QualityKnobs, t: QualityTargets, prev?: QualityKnobs): void {
  if (!prev || prev.renderScale !== k.renderScale) t.renderer.setPixelRatio(ratioOf(k, t))
  if (!prev) t.renderer.shadowMap.enabled = k.shadows
  if (!prev || prev.shadows !== k.shadows || (k.shadows && prev.shadowMapSize !== k.shadowMapSize)) applyShadows(k, t)
  if (!prev || extentOf(prev) !== extentOf(k)) applyShadowExtent(t.sun, extentOf(k))
  if (!prev || prev.post !== k.post) t.setPost(k.post)
  // The shafts live in the post chain: a post cap (?post=0) folded into the knobs keeps them off too.
  const rays = k.volumetrics && k.post
  if (!prev || (prev.volumetrics && prev.post) !== rays) t.setVolumetrics(rays)
  if (!prev || prev.textureSize !== k.textureSize) t.setTextureSize(k.textureSize)
  if (!prev || prev.crowdDensity !== k.crowdDensity || prev.lodDistance !== k.lodDistance ||
    prev.nearRadius !== k.nearRadius || prev.maxDistance !== k.maxDistance) {
    t.setCrowd({ lodDistance: k.lodDistance, nearRadius: k.nearRadius, density: k.crowdDensity, maxDistance: k.maxDistance })
  }
}

function applyShadows(k: QualityKnobs, t: QualityTargets): void {
  const { renderer, sun } = t
  const shadow = sun.shadow
  if (k.shadows) {
    // Compiles the shadowed variant once if this renderer started without it; a no-op afterwards.
    if (!renderer.shadowMap.enabled) renderer.shadowMap.enabled = true
    if (!sun.castShadow) sun.castShadow = true
    if (shadow.mapSize.x !== k.shadowMapSize || shadow.mapSize.y !== k.shadowMapSize) shadow.mapSize.set(k.shadowMapSize, k.shadowMapSize)
    const intensity = parkedIntensity.get(shadow)
    if (intensity !== undefined) {
      shadow.intensity = intensity
      parkedIntensity.delete(shadow)
    }
    shadow.autoUpdate = true
    return
  }
  if (!parkedIntensity.has(shadow)) parkedIntensity.set(shadow, shadow.intensity > 0 ? shadow.intensity : 1)
  shadow.intensity = 0
  shadow.autoUpdate = false
  // Without the shadowed variant there is no shadow map to release.
  if (renderer.shadowMap.enabled && (shadow.mapSize.x !== PARKED_SHADOW_MAP || shadow.mapSize.y !== PARKED_SHADOW_MAP)) {
    shadow.mapSize.set(PARKED_SHADOW_MAP, PARKED_SHADOW_MAP)
    shadow.needsUpdate = true
  }
}

/** The sun's shadow box at ±extent m. Nothing when it already is (so a first application below Peak touches nothing).
 *  three computes a shadow camera's projection at setup only (ShadowNode), so it is recomputed here; the sun follow
 *  (world.ts) reads the texel from the live box. */
function applyShadowExtent(sun: DirectionalLight, extent: number): void {
  const c = sun.shadow.camera
  if (c.left === -extent && c.right === extent && c.top === extent && c.bottom === -extent) return
  c.left = -extent; c.right = extent; c.top = extent; c.bottom = -extent
  c.updateProjectionMatrix()
}
