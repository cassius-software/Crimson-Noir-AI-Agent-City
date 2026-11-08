// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the sun's shadow: three r186's cascaded sun light (three/addons SunLight, two
 * shadow cascades fitted to the view every shadow pass and drawn side by side in one atlas) in place of the one
 * directional light whose fixed box of ±80 m (±160 m on Peak) the world used to carry around the player, and a shadow
 * filter of its own whose tap count is a uniform, so a quality tier can soften the shadows without recompiling a
 * shader.
 *
 * Why cascades. One box around the player spends its texels evenly over 160 m of ground, whatever is near or far, and
 * ends in a line: past the box everything is drawn lit, so a tower's shadow stopped dead eighty metres down the street.
 * A cascade is a box fitted to a slice of what the camera sees: the near slice (the first 42 m on High) gets
 * a small box and so fine texels, the far slice a large one and coarse texels nobody can tell apart at that distance,
 * and the far slice reaches as far as the tier affords (QualityKnobs.shadowDistance: 120 m on Medium to 240 m on
 * Ultra and Peak) and fades out over its last tenth instead of ending in a line. three fits, snaps (to whole texels, so the
 * shadows do not crawl when the head turns) and blends the two itself (SunLightShadow, SunShadowNode); the far plane of
 * the sun's shadow camera is the distance, and the view camera being rendered is the one the cascades are fitted to,
 * so in split screen each player's viewport gets shadows fitted to its own head. Three's own CSMShadowNode (also in
 * r186) was not taken: it clones the light's shadow once at the first compile, so nothing written to the sun's shadow
 * afterwards (the tier's map size, the parking quality.ts does) reaches its cascades.
 *
 * Two things three's sun shadow leaves to the page are done here (CitySunShadow). Casters: three draws casters from one
 * shadow distance sunward of the view frustum's most sunward corner, so facing away from a low sun on Medium it drew
 * towers only about 115 m sunward and facing the sun about 245 m, and a long golden-hour shadow came and went as the
 * head turned; the cascades are pushed sunward here until casters are drawn from at least CASTER_REACH (320 m, where
 * the old box's light sat) whatever the heading. Depth: three's depth bias is a fraction of each cascade's depth range,
 * and three's ranges run from about 150 to 350 m, so the same −0.0003 meant 5 to 10 cm instead of the 21 cm it meant
 * over the old box's 700 m; every cascade here spans at least SHADOW_DEPTH_RANGE (700 m), so the bias means what it
 * always meant.
 *
 * The filter (softShadowFilter) is three's own PCF (a Vogel disk of taps rotated per pixel by interleaved gradient
 * noise, each a hardware depth comparison) with the tap count a uniform, so 5 taps on Medium and 16 on Peak are the
 * same shader; the taps are written out, not looped (see softShadowFilter), and the disk is round on the 2 : 1 atlas.
 * Reversed depth is three's to handle (ShadowNode compares "greater or equal" and subtracts the bias); nothing here
 * compares a depth by hand.
 *
 * What breaks if it is removed? The sun has one shadow box again: coarser near on Medium and High, gone past eighty
 * metres, five taps everywhere.
 */
import { SunLight } from 'three/addons/lights/SunLight.js'
import { SunLightNode } from 'three/addons/lights/SunLightNode.js'
import { SunLightShadow } from 'three/addons/lights/SunLightShadow.js'
import { Vector3, type Camera, type DepthTexture, type Frustum, type Light, type Matrix4, type Node, type OrthographicCamera, type UniformNode, type Vector4, type WebGPURenderer } from 'three/webgpu'
import { Fn, If, float, int, interleavedGradientNoise, reference, renderGroup, screenCoordinate, texture, uniform, vec2, vogelDiskSample } from 'three/tsl'

/**
 * The sun light as the world builds it, before the first quality tier is applied (quality.ts applyQuality writes the
 * map size, the distance, the radius and the taps of the tier before the first frame; these are High's). The biases
 * are three's conventional ones and the one-box days' values: a negative depth bias three subtracts under the reversed
 * buffer, a fraction of a cascade's depth range (−0.0003 of SHADOW_DEPTH_RANGE's 700 m is 21 cm, as it was over the old
 * box's), and a normal bias in metres along the surface normal. `near` is the padding three puts on both ends of a
 * cascade's depth range; it does not move the caster ceiling (CitySunShadow does).
 */
export const SUN_SHADOW = Object.freeze({
  intensity: 3,
  /** Per cascade, texels on each side (the atlas is twice as wide). */
  mapSize: 2048,
  /** The far plane of the sun's shadow camera: how far from the eye shadows are drawn, m. */
  distance: 160,
  /** The filter's Vogel disk, in texels (round on the 2 : 1 atlas). */
  radius: 2,
  /** The filter's taps. */
  taps: 8,
  near: 1,
  bias: -0.0003,
  normalBias: 0.03,
})

/** The most taps the filter is asked for (a tier's shadowTaps), and the fewest: three's own PCF uses five. */
export const SHADOW_TAPS = Object.freeze({ min: 5, max: 16 })

/** How far sunward of the eye casters are drawn from, whatever the heading and the tier, m: where the one-box days'
 *  light sat (320 m out along the sun), so a tower that shadowed the player then shadows the player now. */
export const CASTER_REACH = 320

/** The least depth a cascade spans, m: the one-box days' 700 m (near 1, far 700), over which the depth bias of
 *  SUN_SHADOW.bias is the 21 cm it was tuned as. */
export const SHADOW_DEPTH_RANGE = 700

/** What three's ShadowNode hands a shadow filter (ShadowNode.js setupShadowFilter): the raw depth texture, the
 *  fragment's shadow-map coordinate, the shadow whose `mapSize` and `radius` the filter reads (under the sun it is a
 *  stand-in carrying the atlas size) and the layer of an array texture. */
interface FilterInputs { depthTexture: DepthTexture; shadowCoord: Node<'vec3'>; shadow: object; depthLayer: Node }
type ShadowFilter = (inputs: FilterInputs) => Node<'float'>
type F = Node<'float'>
type I = Node<'int'>
/** A uniform read from an object's property each render (three's reference node; its typing leaves out setGroup). */
type Ref = UniformNode<'float', number>
const refOf = (name: string, type: 'float' | 'vec2', of: object): Ref => (reference(name, type, of) as unknown as Ref).setGroup(renderGroup)

/**
 * three's PCF with the tap count a uniform: `taps` Vogel-disk taps of radius `shadow.radius` texels, rotated per pixel
 * by interleaved gradient noise (so the disk's few taps dither into a smooth penumbra instead of banding), each a
 * hardware depth comparison of the shadow map. The disk is laid out for the uniform count, the first SHADOW_TAPS.min taps
 * are always taken and each one after behind an `if` on the count, written out to SHADOW_TAPS.max, so a tier moves the
 * count with a write. Written out, not looped: a hardware comparison takes screen derivatives, and a shader compiler
 * that refuses those in a loop it cannot count (Direct3D's older one) would leave every lit material unbuilt;
 * written-out taps inside an `if` are what three's own filter already does inside its cascade `if`. The radius is
 * scaled per axis by the atlas size, so the disk is round in texels on the 2 : 1 atlas (three's own PCF scales both
 * axes by the width, which halves it vertically). Returns the lit fraction (1 lit, 0 in shadow).
 */
export function softShadowFilter(taps: UniformNode<'int', number>): ShadowFilter {
  const filter = (inputs: FilterInputs) => {
    const { depthTexture, shadowCoord, shadow, depthLayer } = inputs
    const mapSize = refOf('mapSize', 'vec2', shadow) as unknown as Node<'vec2'>
    const radius = refOf('radius', 'float', shadow)
    const texel = vec2(radius, radius).div(mapSize)
    const phi = interleavedGradientNoise(screenCoordinate.xy).mul(6.28318530718)
    const lit = float(0).toVar()
    const count = taps as unknown as I
    for (let k = 0; k < SHADOW_TAPS.max; k++) {
      const tap = () => {
        const uv = shadowCoord.xy.add(vogelDiskSample(int(k), count, phi).mul(texel))
        const depth = texture(depthTexture, uv)
        const sample = depthTexture.isArrayTexture ? depth.depth(depthLayer) : depth
        lit.addAssign(sample.compare(shadowCoord.z) as unknown as F)
      }
      if (k < SHADOW_TAPS.min) tap()
      else If(count.greaterThan(int(k)), tap)
    }
    return lit.div(float(count))
  }
  return Fn(filter as unknown as (args: { readonly [key: string]: unknown }) => F) as unknown as ShadowFilter
}

/** What three's LightShadow keeps for each cascade and leaves out of its typings. */
interface ShadowInternals {
  _viewports: Vector4[]
  _updateMatrix(camera: OrthographicCamera, matrix: Matrix4, frustum: Frustum, viewport: Vector4): void
}
const toSun = new Vector3()
const eye = new Vector3()
const offset = new Vector3()

/**
 * three's sun shadow, with each cascade camera pushed sunward until casters are drawn from at least CASTER_REACH
 * sunward of the eye, and its far plane held where three put it (or deepened) so it spans at least SHADOW_DEPTH_RANGE.
 * Moving a cascade along the light's own axis leaves three's fit across the light (its texel snapping) as it was: only
 * where the depth range begins and ends moves.
 */
export class CitySunShadow extends SunLightShadow {
  override updateMatrices(light: Light, viewCamera?: Camera): void {
    super.updateMatrices(light, viewCamera)
    if (viewCamera === undefined) return
    toSun.setFromMatrixPosition(light.matrixWorld).normalize()
    eye.setFromMatrixPosition(viewCamera.matrixWorld)
    const inner = this as unknown as ShadowInternals
    for (let i = 0; i < this.getViewportCount(); i++) {
      const camera = this.getCamera(i)
      // The camera looks along −toSun: the eye is this deep in front of it, and its near plane `near` deep.
      const eyeDepth = -offset.subVectors(eye, camera.position).dot(toSun)
      const push = Math.max(0, CASTER_REACH - (eyeDepth - camera.near))
      if (push > 0) {
        camera.position.addScaledVector(toSun, push)
        camera.far += push
      }
      camera.far = Math.max(camera.far, camera.near + SHADOW_DEPTH_RANGE)
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld()
      inner._updateMatrix(camera, this.getMatrix(i), this.getFrustum(i), inner._viewports[i])
    }
  }
}

/** The sun and the knob of its filter the quality tiers write (World.setShadowTaps). */
export interface SunRig {
  light: SunLight
  /** The filter's tap count (an int uniform; SHADOW_TAPS bounds it). */
  taps: UniformNode<'int', number>
}

/**
 * Tells three's node library about the sun light, which three's addons leave to the page: without it the lights node
 * warns and the sun lights nothing. Once per renderer (three warns of a redefinition on a second registration, so a
 * second call does nothing).
 */
export function registerSunLight(renderer: WebGPURenderer): void {
  if ((renderer.library.getLightNodeClass(SunLight as unknown as new () => Light) as unknown) === SunLightNode) return
  renderer.library.addLight(SunLightNode, SunLight)
}

/**
 * The world's sun: three's cascaded sun light, shadowing through CitySunShadow, with SUN_SHADOW's map, distance,
 * radius, taps and biases and the soft filter installed before anything compiles (three reads a shadow's filter when
 * it first builds the shadow, and never again). Its direction is its position (it shines toward the origin, as a
 * HemisphereLight does): World.update writes the sun's or the moon's direction there.
 */
export function createSun(renderer: WebGPURenderer): SunRig {
  registerSunLight(renderer)
  const light = new SunLight(0xffffff, SUN_SHADOW.intensity)
  light.shadow.dispose()
  light.shadow = new CitySunShadow()
  light.castShadow = true
  const shadow = light.shadow as CitySunShadow & { filterNode?: ShadowFilter }
  shadow.mapSize.set(SUN_SHADOW.mapSize, SUN_SHADOW.mapSize)
  shadow.radius = SUN_SHADOW.radius
  shadow.bias = SUN_SHADOW.bias
  shadow.normalBias = SUN_SHADOW.normalBias
  shadow.camera.near = SUN_SHADOW.near
  shadow.camera.far = SUN_SHADOW.distance
  // One uniform for the render, not one per object: the filter is the same for every receiver.
  const taps = uniform(SUN_SHADOW.taps, 'int').setGroup(renderGroup)
  shadow.filterNode = softShadowFilter(taps)
  return { light, taps }
}

/** The tap count a tier asks for, held to SHADOW_TAPS and whole (the uniform is an int). */
export function clampTaps(count: number): number {
  if (!Number.isFinite(count)) return SHADOW_TAPS.min
  return Math.min(SHADOW_TAPS.max, Math.max(SHADOW_TAPS.min, Math.round(count)))
}
