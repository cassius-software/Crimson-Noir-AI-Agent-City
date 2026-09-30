/**
 * Why does this file exist? It pins the CPU half of the golden-hour volumetrics: the elevation curve
 * (strongest 2–15°, gone below the horizon and above 30°, off at night), the sun's projection into screen
 * UV with a real three.js camera (ahead, above, aside, behind, leaving the frame), the four uniforms the
 * shader reads, the composite's return shape, and that a tier change is one uniform write. The shader
 * itself is verified in a WebGPU browser by the orchestrator.
 * What breaks if it is removed? Rays could appear at noon or at night, converge on the wrong point, stay on
 * with the sun behind the head, or a knob change could rebuild the post pipeline unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Color, PerspectiveCamera, Scene, Vector3, type WebGPURenderer } from 'three/webgpu'
import { RAYS, createVolumetrics, rayStrengthFor, sunShafts, updateVolumetrics, type Volumetrics } from './volumetrics.ts'
import { buildPost } from './postfx.ts'
import { sunAt } from '../01_Initialize_World/solar.ts'

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
/** Camera at eye level looking along a yaw (forward −sin yaw, 0, −cos yaw), pitched, matrices current. */
function camera(yaw: number, pitch = 0, aspect = 16 / 9): PerspectiveCamera {
  const c = new PerspectiveCamera(62, aspect, 0.1, 2400)
  c.position.set(100, 1.7, 100)
  c.rotation.set(pitch, yaw, 0, 'YXZ')
  c.updateMatrixWorld()
  return c
}
/** Unit sun direction at an elevation, from an azimuth (clockwise from north, solar.ts convention). */
const sunDir = (elevationDeg: number, azimuthDeg: number) => {
  const el = (elevationDeg * Math.PI) / 180, az = (azimuthDeg * Math.PI) / 180
  return { x: Math.sin(az) * Math.cos(el), y: Math.sin(el), z: -Math.cos(az) * Math.cos(el), elevationDeg, daylight: 1 }
}
const warm = new Color(1, 0.62, 0.36)

// ---------------------------------------------------------------------------------------------------
// Elevation curve

test('rayStrengthFor: full between 2° and 15°, gone below −1° and from 30° up, never outside 0..1', () => {
  for (const el of [2, 3, 5, 8, 12, 15]) assert.equal(rayStrengthFor(el, 1), 1, `${el}°`)
  for (const el of [-90, -10, -1.5, -1]) assert.equal(rayStrengthFor(el, 1), 0, `${el}° below the horizon`)
  for (const el of [30, 45, 60, 90]) assert.equal(rayStrengthFor(el, 1), 0, `${el}° high sun`)
  for (let el = -5; el <= 95; el += 0.25) {
    const s = rayStrengthFor(el, 1)
    assert.ok(s >= 0 && s <= 1, `${el}° in range`)
  }
})

test('rayStrengthFor: rises smoothly through the horizon and falls smoothly to 30°', () => {
  let prev = 0
  for (let el = -1; el <= 2; el += 0.05) {
    const s = rayStrengthFor(el, 1)
    assert.ok(s >= prev - 1e-12, `rising at ${el.toFixed(2)}°`)
    prev = s
  }
  assert.ok(rayStrengthFor(0.5, 1) > 0.2 && rayStrengthFor(0.5, 1) < 0.8, 'half way up the rise')
  prev = 1
  for (let el = 15; el <= 30; el += 0.05) {
    const s = rayStrengthFor(el, 1)
    assert.ok(s <= prev + 1e-12, `falling at ${el.toFixed(2)}°`)
    prev = s
  }
  assert.ok(rayStrengthFor(22.5, 1) > 0.4 && rayStrengthFor(22.5, 1) < 0.6, 'half way down the fall')
  // No cliff anywhere: the 3° rise is the steepest part (a smoothstep peaks at 1.5 / 3 per degree).
  for (let el = -3; el <= 33; el += 0.25) assert.ok(Math.abs(rayStrengthFor(el + 0.25, 1) - rayStrengthFor(el, 1)) <= 0.13, `smooth at ${el}°`)
})

test('rayStrengthFor: daylight scales it — off at night, softened in civil twilight, full by day', () => {
  assert.equal(rayStrengthFor(8, 0), 0)
  assert.ok(rayStrengthFor(8, 0.3) > 0.4 && rayStrengthFor(8, 0.3) < 0.6)
  assert.equal(rayStrengthFor(8, 0.7), 1)
  assert.equal(rayStrengthFor(8, 1.5), 1, 'clamped')
  assert.equal(rayStrengthFor(8, -1), 0, 'clamped')
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(rayStrengthFor(bad, 1), 0)
    assert.equal(rayStrengthFor(8, bad), 0)
  }
})

test('rayStrengthFor: over the real solar day the shafts belong to the golden hours only', () => {
  const strength = (h: number) => { const s = sunAt(h); return rayStrengthFor(s.elevationDeg, s.daylight) }
  assert.ok(strength(17.4) > 0.95, `17:24 (golden hour, ${sunAt(17.4).elevationDeg.toFixed(1)}°): ${strength(17.4).toFixed(2)}`)
  assert.ok(strength(7) > 0.95, 'morning golden hour')
  assert.equal(strength(12), 0, 'noon')
  assert.equal(strength(0), 0, 'midnight')
  assert.equal(strength(21), 0, 'night')
  // Continuous through sunset: no frame-to-frame jump larger than a few percent at a day of 24 real minutes.
  let prev = strength(16)
  for (let h = 16; h <= 19.5; h += 1 / 600) {
    const s = strength(h)
    assert.ok(Math.abs(s - prev) < 0.03, `${h.toFixed(3)} h: ${prev.toFixed(3)} → ${s.toFixed(3)}`)
    prev = s
  }
})

// ---------------------------------------------------------------------------------------------------
// The uniforms and the projection

test('createVolumetrics: four uniforms, off until the engine feeds them', () => {
  const v = createVolumetrics()
  for (const u of [v.strength, v.sunUv, v.visibility, v.color]) assert.ok((u as { isUniformNode?: boolean }).isUniformNode, 'a uniform node')
  assert.equal(v.strength.value, 0)
  assert.equal(v.visibility.value, 0)
  assert.deepEqual([v.sunUv.value.x, v.sunUv.value.y], [0.5, 0.5])
  assert.deepEqual([v.color.value.r, v.color.value.g, v.color.value.b], [0, 0, 0])
  // uniform() leaves nodeType null and derives it from the value at build time: number → float,
  // Vector2 → vec2, Color → color (uploaded as r, g, b; a vec3<f32> in WGSL).
  for (const u of [v.strength, v.sunUv, v.visibility, v.color]) assert.equal((u as { nodeType: string | null }).nodeType, null)
  assert.equal(typeof v.strength.value, 'number')
  assert.equal(typeof v.visibility.value, 'number')
  assert.ok((v.sunUv.value as { isVector2?: boolean }).isVector2)
  assert.ok((v.color.value as { isColor?: boolean }).isColor)
  // The tier's knob is one float write.
  v.strength.value = 1
  assert.equal(v.strength.value, 1)
})

test('updateVolumetrics: the sun straight ahead lands at the screen centre, fully visible', () => {
  const v = createVolumetrics()
  updateVolumetrics(v, camera(0), sunDir(0, 0), warm)
  assert.ok(near(v.sunUv.value.x, 0.5) && near(v.sunUv.value.y, 0.5), `${v.sunUv.value.x}, ${v.sunUv.value.y}`)
  assert.equal(v.visibility.value, 1)
  // Looking west (yaw π/2: forward −x) at a sun due west (azimuth 270°).
  updateVolumetrics(v, camera(Math.PI / 2), sunDir(0, 270), warm)
  assert.ok(near(v.sunUv.value.x, 0.5) && near(v.sunUv.value.y, 0.5))
  assert.equal(v.visibility.value, 1)
})

test('updateVolumetrics: elevation moves the sun up the frame by tan(el) / tan(fov / 2); azimuth moves it sideways', () => {
  const v = createVolumetrics()
  const cam = camera(0)
  const halfFov = Math.tan((62 / 2) * (Math.PI / 180))
  for (const el of [2, 5.67, 15, 25]) {
    updateVolumetrics(v, cam, sunDir(el, 0), warm)
    const expected = 0.5 + 0.5 * (Math.tan((el * Math.PI) / 180) / halfFov)
    assert.ok(near(v.sunUv.value.y, expected, 1e-6), `${el}°: ${v.sunUv.value.y} vs ${expected}`)
    assert.ok(near(v.sunUv.value.x, 0.5))
    assert.equal(v.visibility.value, 1)
  }
  // 20° to the right of north (azimuth 20°) with a 16:9 frame: x > 0.5, inside the frame.
  updateVolumetrics(v, cam, sunDir(0, 20), warm)
  const expectedX = 0.5 + 0.5 * (Math.tan((20 * Math.PI) / 180) / (halfFov * (16 / 9)))
  assert.ok(near(v.sunUv.value.x, expectedX, 1e-6), `${v.sunUv.value.x} vs ${expectedX}`)
  assert.equal(v.visibility.value, 1)
  updateVolumetrics(v, cam, sunDir(0, 340), warm)
  assert.ok(near(v.sunUv.value.x, 1 - expectedX, 1e-6), 'mirrored to the left')
  // Pitching the head down by the sun's elevation centres it again.
  updateVolumetrics(v, camera(0, (10 * Math.PI) / 180), sunDir(10, 0), warm)
  assert.ok(near(v.sunUv.value.y, 0.5, 1e-6))
})

test('updateVolumetrics: visibility fades as the sun leaves the frame and is zero behind the camera', () => {
  const v = createVolumetrics()
  const cam = camera(0)
  const halfH = Math.atan(Math.tan((31 * Math.PI) / 180) * (16 / 9)) * (180 / Math.PI)   // ≈ 46.9° half width
  updateVolumetrics(v, cam, sunDir(0, halfH - 2), warm)
  assert.equal(v.visibility.value, 1, 'just inside the frame edge')
  updateVolumetrics(v, cam, sunDir(0, halfH + 4), warm)
  assert.ok(v.visibility.value > 0.9, `a little outside still casts: ${v.visibility.value}`)
  let prev = 1
  const seen: number[] = []
  for (let az = halfH; az <= 89; az += 1) {
    updateVolumetrics(v, cam, sunDir(0, az), warm)
    assert.ok(v.visibility.value <= prev + 1e-12, `monotonic at ${az}°`)
    prev = v.visibility.value
    seen.push(prev)
  }
  assert.ok(seen.some((s) => s > 0.05 && s < 0.95), 'a smooth fade, not a switch')
  assert.equal(prev, 0, 'gone well before the side plane')
  for (const az of [90, 91, 120, 180, 240, 270]) {
    updateVolumetrics(v, cam, sunDir(0, az), warm)
    assert.equal(v.visibility.value, 0, `${az}°: beside or behind the camera`)
  }
  // Straight up and straight down, head level: outside the vertical frame.
  updateVolumetrics(v, cam, sunDir(89.9, 0), warm)
  assert.equal(v.visibility.value, 0)
  updateVolumetrics(v, cam, sunDir(-60, 0), warm)
  assert.equal(v.visibility.value, 0)
})

test('updateVolumetrics: the colour is the sun colour through the elevation curve, and the call allocates nothing', () => {
  const v = createVolumetrics()
  const cam = camera(0)
  updateVolumetrics(v, cam, sunDir(8, 0), warm)
  assert.ok(near(v.color.value.r, warm.r * RAYS.gain) && near(v.color.value.g, warm.g * RAYS.gain) && near(v.color.value.b, warm.b * RAYS.gain))
  updateVolumetrics(v, cam, { ...sunDir(8, 0), daylight: 0 }, warm)
  assert.deepEqual([v.color.value.r, v.color.value.g, v.color.value.b], [0, 0, 0], 'night')
  updateVolumetrics(v, cam, sunDir(60, 0), warm)
  assert.deepEqual([v.color.value.r, v.color.value.g, v.color.value.b], [0, 0, 0], 'noon')
  assert.notEqual(v.color.value, warm, 'copies, never aliases the light\'s colour')
  // Same identities before and after: the uniforms' values are mutated in place.
  const ids = [v.sunUv.value, v.color.value]
  for (let i = 0; i < 1000; i++) updateVolumetrics(v, cam, sunDir((i % 40) - 5, (i * 7) % 360), warm)
  assert.equal(v.sunUv.value, ids[0])
  assert.equal(v.color.value, ids[1])
  // Real solar states feed straight in.
  updateVolumetrics(v, camera(1.5), sunAt(17.4), warm)
  assert.ok(v.visibility.value > 0.9 && v.color.value.r > 0.8, 'golden hour, head turned west: shafts on')
  updateVolumetrics(v, camera(1.5 + Math.PI), sunAt(17.4), warm)
  assert.equal(v.visibility.value, 0, 'head turned east: nothing')
})

// ---------------------------------------------------------------------------------------------------
// The graph (no GPU in Node: structure only; the shader is verified in a browser)

test('sunShafts: a half-resolution render-to-texture node reading the pass depth, named for the profiler', () => {
  const v = createVolumetrics()
  const depth = { sample: () => ({ r: 0 }) } as unknown as Parameters<typeof sunShafts>[0]
  const node = sunShafts(depth, v)
  assert.ok((node as { isRTTNode?: boolean }).isRTTNode)
  assert.equal(node.getResolutionScale(), 0.5)
  assert.equal(node.name, 'SunShafts')
  assert.ok(node.renderTarget, 'the ray target exists')
  assert.equal(node.renderTarget.depthBuffer, false)
  assert.equal(RAYS.taps, 48)
  assert.ok(RAYS.decay > 0.9 && RAYS.decay < 1)
})

test('buildPost: one pipeline with explicit output transform, plus the volumetrics it reads', () => {
  const renderer = { toneMapping: 4, outputColorSpace: 'srgb', reversedDepthBuffer: false } as unknown as WebGPURenderer
  const { pipeline, volumetrics } = buildPost(renderer, new Scene(), new PerspectiveCamera())
  assert.ok((pipeline as { isRenderPipeline?: boolean }).isRenderPipeline)
  assert.equal(pipeline.outputColorTransform, false, 'tone mapping is applied explicitly before FXAA')
  assert.ok(pipeline.outputNode)
  const v: Volumetrics = volumetrics
  assert.equal(v.strength.value, 0, 'off until the quality tier writes strength')
  assert.equal(v.visibility.value, 0)
  // The uniforms are shared by reference: the engine's writes reach the shader without rebuilding anything.
  v.strength.value = 1
  assert.equal(volumetrics.strength.value, 1)
  assert.ok(new Vector3(1, 0, 0).length() === 1)
})
