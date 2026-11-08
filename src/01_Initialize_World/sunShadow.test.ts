// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the sun's shadow rig (sunShadow.ts) without a GPU: the sun is three's cascaded
 * sun light, known to the renderer's node library (once), built with the filter installed before anything compiles,
 * two cascades side by side in one atlas, the far plane the distance; the cascades drawing casters from CASTER_REACH
 * sunward whichever way the head turns, over at least SHADOW_DEPTH_RANGE, without moving three's fit across the light;
 * and the taps held to their bounds. shadowShaders.test.ts builds the WGSL.
 * What breaks if it is removed? The sun could silently go back to a light three does not know (it lights nothing and
 * warns), the filter could be installed after the first build, when three no longer reads it, or a tower's shadow
 * could again come and go as the player turns.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PerspectiveCamera, Vector3, WebGPUCoordinateSystem, WebGPURenderer, type Light } from 'three/webgpu'
import { SunLight } from 'three/addons/lights/SunLight.js'
import { SunLightNode } from 'three/addons/lights/SunLightNode.js'
import { SunLightShadow } from 'three/addons/lights/SunLightShadow.js'
import { CASTER_REACH, CitySunShadow, SHADOW_DEPTH_RANGE, SHADOW_TAPS, SUN_SHADOW, clampTaps, createSun, registerSunLight } from './sunShadow.ts'
import { TIERS, PEAK, LITE } from '../05_Observe_Environment/governor.ts'

/** A renderer never initialised: its node library is all this needs. */
function renderer(): WebGPURenderer {
  const canvas = { style: {}, width: 1, height: 1, addEventListener() {}, removeEventListener() {}, getContext: () => null }
  return new WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement, reversedDepthBuffer: true })
}

test('createSun: three\'s cascaded sun light, registered with the renderer, shadowing from SUN_SHADOW with the filter installed', () => {
  const r = renderer()
  const { light, taps } = createSun(r)
  assert.ok(light instanceof SunLight)
  assert.ok(light.shadow instanceof CitySunShadow, 'the shadow that reaches casters sunward')
  assert.equal(r.library.getLightNodeClass(SunLight as unknown as new () => Light), SunLightNode, 'the renderer knows the sun light')
  assert.equal(light.intensity, SUN_SHADOW.intensity)
  assert.equal(light.castShadow, true)
  const shadow = light.shadow as typeof light.shadow & { filterNode?: unknown }
  assert.equal(typeof shadow.filterNode, 'function', 'the filter is on the shadow before the first build (three reads it once)')
  assert.deepEqual([shadow.mapSize.x, shadow.mapSize.y], [SUN_SHADOW.mapSize, SUN_SHADOW.mapSize])
  assert.equal(shadow.radius, SUN_SHADOW.radius)
  assert.equal(shadow.bias, SUN_SHADOW.bias)
  assert.equal(shadow.normalBias, SUN_SHADOW.normalBias)
  assert.equal(shadow.camera.near, SUN_SHADOW.near)
  assert.equal(shadow.camera.far, SUN_SHADOW.distance, 'the far plane is the distance three fits the cascades out to')
  assert.equal(shadow.getViewportCount(), 2, 'two cascades')
  assert.deepEqual([shadow.getFrameExtents().x, shadow.getFrameExtents().y], [2, 1], 'side by side in one atlas')
  assert.equal(taps.value, SUN_SHADOW.taps)
  assert.equal(taps.nodeType, 'int')
  // The light shines toward the origin from its position: a direction, no target to move.
  assert.equal((light as unknown as { target?: unknown }).target, undefined)
  // Registering again does nothing (three would warn of a redefinition).
  const lights = (r.library as unknown as { lightNodes: Map<unknown, unknown> }).lightNodes
  const size = lights.size
  registerSunLight(r)
  assert.equal(lights.size, size)
  assert.equal(r.library.getLightNodeClass(SunLight as unknown as new () => Light), SunLightNode)
})

test('SUN_SHADOW is High\'s tier before the first application, and the biases are three\'s conventional ones', () => {
  const high = TIERS[3]
  assert.equal(high.label, 'High')
  assert.equal(SUN_SHADOW.mapSize, high.shadowMapSize)
  assert.equal(SUN_SHADOW.distance, high.shadowDistance)
  assert.equal(SUN_SHADOW.radius, high.shadowRadius)
  assert.equal(SUN_SHADOW.taps, high.shadowTaps)
  assert.ok(SUN_SHADOW.bias < 0, 'a negative depth bias, which three subtracts under the reversed buffer (ShadowNode)')
  assert.ok(SUN_SHADOW.normalBias > 0 && SUN_SHADOW.normalBias < 0.1, 'a few centimetres along the normal')
  assert.ok(SUN_SHADOW.near > 0)
})

test('clampTaps: whole, within SHADOW_TAPS, and every tier\'s count is already within', () => {
  assert.equal(clampTaps(8), 8)
  assert.equal(clampTaps(8.4), 8)
  assert.equal(clampTaps(1), SHADOW_TAPS.min)
  assert.equal(clampTaps(99), SHADOW_TAPS.max)
  assert.equal(clampTaps(Number.NaN), SHADOW_TAPS.min)
  assert.equal(clampTaps(-Infinity), SHADOW_TAPS.min)
  assert.equal(SHADOW_TAPS.min, 5, 'three\'s own PCF count')
  for (const t of [LITE, ...TIERS, PEAK]) assert.equal(clampTaps(t.shadowTaps), t.shadowTaps, `${t.label}: ${t.shadowTaps} taps as written`)
  assert.equal(PEAK.shadowTaps, SHADOW_TAPS.max)
})

/** Both shadows fitted as a frame fits them: the world camera's lens, the eye at head height, a low sun. */
function fitted(far: number, yaw: number, elevationDeg: number) {
  const e = elevationDeg * Math.PI / 180
  const sun = new SunLight()
  sun.position.set(0, Math.sin(e), -Math.cos(e))
  sun.updateMatrixWorld()
  const view = new PerspectiveCamera(62, 16 / 9, 0.1, 2400)
  view.coordinateSystem = WebGPUCoordinateSystem
  view.position.set(10, 1.7, 20)
  view.rotation.set(0, yaw, 0)
  view.updateMatrixWorld()
  view.updateProjectionMatrix()
  const make = (shadow: SunLightShadow) => {
    shadow.mapSize.set(1024, 1024)
    shadow.radius = 1.5
    shadow.camera.near = SUN_SHADOW.near
    shadow.camera.far = far
    shadow.camera.coordinateSystem = WebGPUCoordinateSystem
    shadow.updateMatrices(sun, view)
    return shadow
  }
  return { three: make(new SunLightShadow()), city: make(new CitySunShadow()), toSun: sun.position.clone().normalize(), eye: view.position.clone() }
}

test('CitySunShadow: casters from CASTER_REACH sunward whatever the heading, over SHADOW_DEPTH_RANGE, three\'s fit across the light untouched', () => {
  for (const far of [120, 160, 240]) {
    for (const yaw of [0, Math.PI / 2, Math.PI]) {
      for (const elevation of [3, 10, 45]) {
        const { three, city, toSun, eye } = fitted(far, yaw, elevation)
        for (let i = 0; i < 2; i++) {
          const a = three.getCamera(i)
          const b = city.getCamera(i)
          const sunward = (c: typeof a) => -new Vector3().subVectors(eye, c.position).dot(toSun) - c.near
          const at = `${far} m, yaw ${yaw.toFixed(2)}, sun ${elevation}°, cascade ${i}`
          assert.ok(sunward(b) >= CASTER_REACH - 1e-6, `${at}: casters from ${sunward(b).toFixed(0)} m sunward`)
          assert.ok(sunward(b) >= sunward(a) - 1e-6, `${at}: never less than three's own ceiling`)
          assert.ok(b.far - b.near >= SHADOW_DEPTH_RANGE - 1e-6, `${at}: a depth range of ${(b.far - b.near).toFixed(0)} m`)
          // The far plane is three's or deeper: every receiver three fitted is still inside.
          const farPlane = (c: typeof a) => -new Vector3().subVectors(eye, c.position).dot(toSun) - c.far
          assert.ok(farPlane(b) <= farPlane(a) + 1e-6, `${at}: the far plane no nearer the sun than three's`)
          // Moved along the light only: the box across it, and so its texel snapping, is three's.
          const across = (c: typeof a) => c.position.clone().sub(toSun.clone().multiplyScalar(c.position.dot(toSun)))
          assert.ok(across(a).distanceTo(across(b)) < 1e-6, `${at}: the fit across the light is three's`)
          assert.deepEqual([b.left, b.right, b.top, b.bottom], [a.left, a.right, a.top, a.bottom])
          assert.ok(b.quaternion.equals(a.quaternion))
          // The shadow transform the receivers read is rebuilt for the moved camera.
          const p = new Vector3().copy(eye).applyMatrix4(city.getMatrix(i))
          assert.ok(p.z > 0 && p.z < 1, `${at}: the eye inside the cascade's depth (${p.z.toFixed(3)})`)
        }
      }
    }
  }
  // Facing away from a low sun on Medium, three alone draws casters only a shadow distance sunward: the case fixed.
  const away = fitted(120, Math.PI, 5)
  const c = away.three.getCamera(0)
  assert.ok(-new Vector3().subVectors(away.eye, c.position).dot(away.toSun) - c.near < 130, 'three\'s own ceiling, facing away, is about 120 m sunward')
})
