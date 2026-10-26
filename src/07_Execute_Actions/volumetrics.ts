// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Golden-hour volumetrics for the Ultra tier: screen-space crepuscular rays (sun
 * shafts) in the post chain. The scene pass's depth is the occlusion mask (sky = the far plane; buildings,
 * people and cars occlude), radially blurred toward the sun's screen position at half resolution with
 * exponentially decaying tap weights, and added to the HDR colour before tone mapping. The CPU side projects
 * the sun once per frame into four uniforms (strength, sunUv, visibility, colour); the shader gates its tap
 * loop on them, so every tier below Ultra pays one trivial half-res quad and a tier change never rebuilds a
 * pipeline (the tier only writes `strength`).
 * What breaks if it is removed? postfx.ts has no rays to add and quality.ts has nothing to switch: Ultra
 * looks like High.
 */
import { Color, Vector2, Vector3, type Node, type PerspectiveCamera, type TextureNode, type UniformNode } from 'three/webgpu'
import {
  Fn, If, Loop, abs, float, interleavedGradientNoise, max, rtt, screenCoordinate, screenSize, step, uniform, uv,
  vec2, vec3, vec4,
} from 'three/tsl'

export interface Volumetrics {
  /** The quality tier's knob: 1 on Ultra and Peak, 0 elsewhere (an operator may scale it). Gates the tap loop. */
  strength: UniformNode<'float', number>
  /** The sun's screen position in three's UV convention (0..1, y up), meaningful only while visibility > 0. */
  sunUv: UniformNode<'vec2', Vector2>
  /** 0..1: the sun is in front of the camera and inside or near the frame; 0 behind the camera. */
  visibility: UniformNode<'float', number>
  /** Ray colour: the sun colour scaled by the elevation curve (black at night and from ~30° up). */
  color: UniformNode<'vec3', Color>
}

/** The radial blur, tuned for ~48 half-res taps: one pass, no second blur. */
export const RAYS = {
  taps: 48,
  /** Per-tap weight decay: the sky near the sun feeds the shaft more than the sky near the pixel. */
  decay: 0.96,
  /** Rays are sampled at this fraction of the drawing buffer (4 taps per full-res pixel's worth). */
  resolutionScale: 0.5,
  /** Only sky within this radius of the sun (uv units, aspect-corrected) is a light source. */
  radius: 0.8,
  /** Visibility fades between these distances outside the unit square (uv units). */
  fadeStart: 0.15,
  fadeEnd: 0.75,
  /** Linear HDR gain of a fully lit shaft (sunlit surfaces are about 2; the sky near the sun saturates anyway,
   *  so the shafts read on facades, people and the road whose ray paths cross sky). */
  gain: 1.5,
  /** Depth this close to the far plane is sky: the sky mesh writes no depth, so sky pixels hold the clear value (1, or
   *  0 with the reversed buffer world.ts asks for); the ground ends at ~1600 m, which is ~6e-5 from the far plane
   *  either way, and a 24-bit buffer resolves ~6e-8. */
  skyEpsilon: 1e-5,
} as const

const smooth = (t: number): number => {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

/** The elevation curve: 0 below −1°, rising to 1 by 2°, full to 15°, gone by 30°; scaled by daylight so
 *  twilight (daylight < 0.6) softens it and night (0) removes it. Pure; NaN reads as 0. */
export function rayStrengthFor(elevationDeg: number, daylight: number): number {
  if (!Number.isFinite(elevationDeg) || !Number.isFinite(daylight)) return 0
  const rise = smooth((elevationDeg + 1) / 3)
  const fall = 1 - smooth((elevationDeg - 15) / 15)
  return rise * fall * Math.min(1, Math.max(0, daylight) * 1.7)
}

export function createVolumetrics(): Volumetrics {
  return {
    strength: uniform(0),
    sunUv: uniform(new Vector2(0.5, 0.5)),
    visibility: uniform(0),
    // Uploaded as a colour (r, g, b), a vec3<f32> in WGSL; the node type only names the WGSL type.
    color: uniform(new Color(0, 0, 0)) as unknown as UniformNode<'vec3', Color>,
  }
}

const dir = new Vector3()

/** Called once per frame by the engine after world.update() (the head rig has updated the camera's
 *  matrices): projects the sun direction with the camera, sets sunUv (0..1), visibility (0..1: in front of
 *  the camera and inside/near the frame) and the colour from the sun colour and elevation. Allocation-free. */
export function updateVolumetrics(
  v: Volumetrics, camera: PerspectiveCamera,
  sun: { x: number; y: number; z: number; elevationDeg: number; daylight: number }, sunColor: Color,
): void {
  v.color.value.copy(sunColor).multiplyScalar(RAYS.gain * rayStrengthFor(sun.elevationDeg, sun.daylight))
  // The sun is at infinity: a direction, so only the camera's rotation and projection apply (no translation).
  dir.set(sun.x, sun.y, sun.z).transformDirection(camera.matrixWorldInverse)
  const e = camera.projectionMatrix.elements
  const w = e[3] * dir.x + e[7] * dir.y + e[11] * dir.z
  if (!(w > 1e-6)) {
    // Behind the camera (or on its side plane, where the projection is singular): sunUv keeps its last value.
    v.visibility.value = 0
    return
  }
  const u = 0.5 + (0.5 * (e[0] * dir.x + e[4] * dir.y + e[8] * dir.z)) / w
  const t = 0.5 + (0.5 * (e[1] * dir.x + e[5] * dir.y + e[9] * dir.z)) / w
  v.sunUv.value.set(u, t)
  const outside = Math.max(0, -u, u - 1, -t, t - 1)
  v.visibility.value = 1 - smooth((outside - RAYS.fadeStart) / (RAYS.fadeEnd - RAYS.fadeStart))
}

/**
 * The half-resolution ray texture: for every pixel, RAYS.taps samples of the scene pass's depth along the
 * ray toward sunUv, each 1 where the depth is sky (and inside the frame, and within RAYS.radius of the sun),
 * weighted by decay^i, normalised, coloured and scaled by strength × visibility. The whole loop sits behind
 * `If(strength > 0 && visibility > 0 && colour > 0)`: three uniforms, so the branch is uniform on the GPU,
 * the shader compiles once, and at strength 0 (every tier below Ultra) the quad writes black and returns.
 * `reversedDepth` mirrors renderer.reversedDepthBuffer (sky at 0 instead of 1).
 */
export function sunShafts(depth: TextureNode, v: Volumetrics, reversedDepth = false) {
  const norm = (1 - RAYS.decay ** RAYS.taps) / (1 - RAYS.decay)
  const sky = (p: Node<'vec2'>): Node<'float'> => {
    const d = depth.sample(p).r
    return reversedDepth ? step(d, float(RAYS.skyEpsilon)) : step(float(1 - RAYS.skyEpsilon), d)
  }
  const shafts = Fn(() => {
    const out = vec3(0).toVar()
    const lit = v.color.r.add(v.color.g).add(v.color.b).greaterThan(0)
    If(v.strength.greaterThan(0).and(v.visibility.greaterThan(0)).and(lit), () => {
      const p = vec2(uv()).toVar()
      const aspect = vec2(screenSize.x.div(screenSize.y), 1).toConst()
      const delta = v.sunUv.sub(p).div(RAYS.taps).toConst()
      // A per-pixel start offset turns tap banding into fine noise the half-res upsample smooths away.
      p.addAssign(delta.mul(interleavedGradientNoise(screenCoordinate)))
      const sum = float(0).toVar()
      const w = float(1).toVar()
      Loop(RAYS.taps, () => {
        p.addAssign(delta)
        const inFrame = step(max(abs(p.x.sub(0.5)), abs(p.y.sub(0.5))), 0.5)
        const near = float(1).sub(p.sub(v.sunUv).mul(aspect).length().div(RAYS.radius)).max(0)
        sum.addAssign(sky(p).mul(inFrame).mul(near.mul(near)).mul(w))
        w.mulAssign(RAYS.decay)
      })
      out.assign(v.color.mul(sum.div(norm)).mul(v.strength.mul(v.visibility)))
    })
    return vec4(out, 1)
  })
  const node = rtt(shafts(), null, null, { resolutionScale: RAYS.resolutionScale, depthBuffer: false })
  node.name = 'SunShafts'
  return node
}
