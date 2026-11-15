// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the headset session (xrSession.ts) against fakes of three's XRManager, a
 * WebXR session and a browser's XR system: the frustum read off a projection matrix whatever its depth rows, the
 * eye projections rewritten as the page's own (WebGPU clip space, reversed depth, the camera's near and far), the
 * cull's union on the user camera and on three's XR camera, and the session's life: asked for synchronously inside
 * the gesture with the webgpu feature, the loop registered before setSession and the end listener after, sources to
 * the host and the mapper, a pinch to select, every refusal (no WebXR, no binding, the browser throwing or
 * rejecting, a session without the feature, setSession failing, a cancel while entering), the exit and a headset's
 * own end. No headset has run it: UNCONFIRMED on real hardware.
 * What breaks if it is removed? A regression could hand three the browser's depth rows under a reversed-depth
 * renderer (nothing drawn, or everything culled), or leave the page's loop running against the headset's.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Matrix4, PerspectiveCamera, Vector4, WebGLCoordinateSystem, WebGPUCoordinateSystem } from 'three/webgpu'
import { XrMapper } from '../04_Connect_Hardware/xrInput.ts'
import { hasWebGpuBinding, headsetPossible, immersiveModes, sessionModes, xrSystemOf } from '../04_Connect_Hardware/xrSystem.ts'
import type { XrInputSourceLike, XrSessionLike, XrSessionMode, XrSystemLike } from '../04_Connect_Hardware/web-hardware.d.ts'
import { composerFor, frustumTangents, reversedEyeProjection, UNION_MARGIN, unionProjection, XR_FEATURES, XrPresence, type EyeCameraLike, type XrHost, type XrRendererLike } from './xrSession.ts'

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps

/** A browser's eye projection: WebGL depth rows, its own near and far, the tangents (l, r, t, b over near). */
function browserEye(l: number, r: number, t: number, b: number, near = 0.01, far = 1000): EyeCameraLike {
  const m = new Matrix4().makePerspective(l * near, r * near, t * near, b * near, near, far)
  return { projectionMatrix: m, projectionMatrixInverse: m.clone().invert(), coordinateSystem: WebGLCoordinateSystem }
}
const tangentsOf = (m: Matrix4) => {
  const t = { left: 0, right: 0, top: 0, bottom: 0 }
  assert.ok(frustumTangents(m.elements, t), 'a perspective')
  return t
}
const ndcZ = (m: Matrix4, z: number) => { const v = new Vector4(0, 0, z, 1).applyMatrix4(m); return v.z / v.w }
const ndcX = (m: Matrix4, x: number, z: number) => { const v = new Vector4(x, 0, z, 1).applyMatrix4(m); return v.x / v.w }
const reversed = (c: object) => (c as { _reversedDepth?: boolean })._reversedDepth === true

function controller(handedness: 'left' | 'right'): XrInputSourceLike {
  return { handedness, targetRayMode: 'tracked-pointer', profiles: ['generic-trigger-squeeze-thumbstick'], gamepad: { mapping: 'xr-standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 7 }, () => ({ pressed: false, value: 0 })) } }
}
const pinchSource = (): XrInputSourceLike => ({ handedness: 'none', targetRayMode: 'transient-pointer', profiles: [], gamepad: null })

class FakeSession {
  inputSources: XrInputSourceLike[] = []
  enabledFeatures: readonly string[] | undefined = ['webgpu', 'local-floor']
  environmentBlendMode: string | undefined = 'opaque'
  ended = 0
  private readonly listeners = new Map<string, Set<(e: never) => void>>()
  addEventListener(type: string, listener: (e: never) => void): void {
    let set = this.listeners.get(type)
    if (!set) { set = new Set(); this.listeners.set(type, set) }
    set.add(listener)
  }
  removeEventListener(type: string, listener: (e: never) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  end(): Promise<void> {
    this.ended++
    queueMicrotask(() => this.fire('end', {}))
    return Promise.resolve()
  }
  fire(type: string, e: unknown): void {
    for (const l of this.listeners.get(type) ?? []) (l as (e: unknown) => void)(e)
  }
  has(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

function fakeXr(o: { vr?: boolean; ar?: boolean; session?: () => Promise<XrSessionLike>; throws?: string } = {}) {
  const asked: { mode: XrSessionMode; init: unknown }[] = []
  const xr: XrSystemLike = {
    isSessionSupported: (mode) => Promise.resolve(mode === 'immersive-vr' ? o.vr !== false : o.ar === true),
    requestSession: (mode, init) => {
      asked.push({ mode, init })
      if (o.throws) throw new Error(o.throws)
      return (o.session ?? (() => Promise.resolve(new FakeSession())))()
    },
  }
  return { xr, asked }
}

function fakeRenderer() {
  const log: string[] = []
  let loop: ((t: number) => void) | null = null
  let frame: unknown = null
  const xrCamera = Object.assign(new PerspectiveCamera(), { cameras: [] as EyeCameraLike[] })
  const r = {
    xr: {
      enabled: false,
      cameraAutoUpdate: true,
      setSession: (_s: XrSessionLike) => {
        log.push(`setSession loop=${loop ? 'set' : 'none'} enabled=${r.xr.enabled} auto=${r.xr.cameraAutoUpdate}`)
        return r.refuse ? Promise.reject(new Error(r.refuse)) : Promise.resolve()
      },
      getFrame: () => frame,
      getCamera: () => xrCamera,
      updateCamera: (_c: PerspectiveCamera) => {},
    },
    setAnimationLoop: (cb: ((t: number) => void) | null) => { loop = cb; log.push(`loop ${cb ? 'set' : 'null'}`) },
    refuse: '',
    log,
    tick: (t: number) => { frame = {}; loop?.(t); frame = null },
    get loop() { return loop },
  }
  return r
}

function fakeHost() {
  const h = { events: [] as string[], frames: [] as number[], host: null as unknown as XrHost }
  h.host = {
    frame: (t) => { h.frames.push(t) },
    sources: (list) => { h.events.push(`sources ${list ? list.length : 'null'}`) },
    select: (s) => { h.events.push(`select ${s.targetRayMode}`) },
    started: (mode, blend) => { h.events.push(`started ${mode} ${blend}`) },
    ended: () => { h.events.push('ended') },
  }
  return h
}
const settle = () => new Promise((res) => setTimeout(res, 0))

test('frustumTangents reads the frustum off a projection matrix whatever its depth rows; a matrix that is no perspective is refused', () => {
  const t = tangentsOf(browserEye(-0.2, 0.5, 0.3, -0.4).projectionMatrix)
  assert.ok(close(t.left, -0.2) && close(t.right, 0.5) && close(t.top, 0.3) && close(t.bottom, -0.4), JSON.stringify(t))
  const gpu = new Matrix4().makePerspective(-0.2 * 0.3, 0.5 * 0.3, 0.3 * 0.3, -0.4 * 0.3, 0.3, 500, WebGPUCoordinateSystem, true)
  const u = tangentsOf(gpu)
  assert.ok(close(u.left, -0.2) && close(u.right, 0.5) && close(u.top, 0.3) && close(u.bottom, -0.4), 'the depth rows do not matter')
  const cam = new PerspectiveCamera(60, 1.5, 0.1, 100)
  const s = tangentsOf(cam.projectionMatrix)
  const half = Math.tan(Math.PI / 6)
  assert.ok(close(s.top, half) && close(s.bottom, -half) && close(s.right, half * 1.5) && close(s.left, -half * 1.5))
  const out = { left: 1, right: 1, top: 1, bottom: 1 }
  assert.equal(frustumTangents(new Matrix4().elements, out), false, 'the identity')
  assert.equal(frustumTangents(new Matrix4().makeOrthographic(-1, 1, 1, -1, 0.1, 10).elements, out), false, 'orthographic')
  assert.equal(frustumTangents(new Float32Array(16), out), false, 'zeros')
  assert.deepEqual(out, { left: 1, right: 1, top: 1, bottom: 1 }, 'nothing written')
})

test('reversedEyeProjection: the browser\'s frustum between the page\'s near and far, WebGPU clip space with reversed depth (near 1, far 0), marked for three\'s cull', () => {
  const eye = browserEye(-0.2, 0.5, 0.3, -0.4)
  assert.equal(reversedEyeProjection(eye, 0.3, 500), true)
  const t = tangentsOf(eye.projectionMatrix)
  assert.ok(close(t.left, -0.2) && close(t.right, 0.5) && close(t.top, 0.3) && close(t.bottom, -0.4), 'the frustum is the browser\'s')
  assert.ok(close(ndcZ(eye.projectionMatrix, -0.3), 1) && close(ndcZ(eye.projectionMatrix, -500), 0, 1e-6), 'reversed depth between the page\'s planes')
  assert.ok(ndcZ(eye.projectionMatrix, -5) > ndcZ(eye.projectionMatrix, -50), 'nearer is greater')
  assert.equal(eye.coordinateSystem, WebGPUCoordinateSystem)
  assert.equal(reversed(eye), true)
  const back = eye.projectionMatrix.clone().multiply(eye.projectionMatrixInverse)
  assert.ok(back.elements.every((v, i) => close(v, i % 5 === 0 ? 1 : 0, 1e-9)), 'the inverse is kept in step')
  const flat: EyeCameraLike = { projectionMatrix: new Matrix4(), projectionMatrixInverse: new Matrix4(), coordinateSystem: WebGLCoordinateSystem }
  assert.equal(reversedEyeProjection(flat, 0.3, 500), false)
  assert.equal(flat.coordinateSystem, WebGLCoordinateSystem, 'untouched')
  assert.equal(reversed(flat), false)
})

test('unionProjection: the camera\'s projection is the eyes\' union, a margin wider on every side, reversed depth between its own near and far', () => {
  const camera = new PerspectiveCamera(70, 1, 0.3, 500)
  const eyes = [browserEye(-0.6, 0.4, 0.5, -0.5), browserEye(-0.4, 0.6, 0.5, -0.5)]
  assert.equal(unionProjection(camera, eyes, 0), true)
  let t = tangentsOf(camera.projectionMatrix)
  assert.ok(close(t.left, -0.6) && close(t.right, 0.6) && close(t.top, 0.5) && close(t.bottom, -0.5), `exact union: ${JSON.stringify(t)}`)
  assert.equal(unionProjection(camera, eyes), true)
  t = tangentsOf(camera.projectionMatrix)
  const w = (tan: number, out: number) => Math.tan(Math.atan(tan) + out)
  assert.ok(close(t.left, w(-0.6, -UNION_MARGIN)) && close(t.right, w(0.6, UNION_MARGIN)) && close(t.top, w(0.5, UNION_MARGIN)) && close(t.bottom, w(-0.5, -UNION_MARGIN)))
  assert.ok(close(UNION_MARGIN, (4 * Math.PI) / 180))
  assert.ok(close(ndcZ(camera.projectionMatrix, -0.3), 1) && close(ndcZ(camera.projectionMatrix, -500), 0, 1e-6))
  assert.ok(Math.abs(ndcX(camera.projectionMatrix, -0.59 * 10, -10)) < 1, 'what the left eye sees at its far edge is inside the union')
  assert.ok(ndcX(camera.projectionMatrix, -0.75 * 10, -10) < -1, 'what neither eye sees, past the margin, is outside')
  const before = camera.projectionMatrix.clone()
  assert.equal(unionProjection(camera, []), false)
  assert.equal(unionProjection(camera, [{ projectionMatrix: new Matrix4(), projectionMatrixInverse: new Matrix4(), coordinateSystem: WebGLCoordinateSystem }]), false)
  assert.deepEqual(camera.projectionMatrix.elements, before.elements, 'without a perspective eye nothing changes')
})

test('composerFor: each eye made the page\'s own before three reads them, three\'s composition under the rig, then the union on the user camera and on three\'s XR camera', () => {
  const eyes = [browserEye(-0.6, 0.4, 0.5, -0.5), browserEye(-0.4, 0.6, 0.5, -0.5)]
  const xrCamera = Object.assign(new PerspectiveCamera(), { cameras: eyes })
  xrCamera.coordinateSystem = WebGLCoordinateSystem
  const calls: string[] = []
  const renderer: XrRendererLike = {
    xr: {
      enabled: true,
      cameraAutoUpdate: true,
      setSession: () => Promise.resolve(),
      getFrame: () => null,
      getCamera: () => xrCamera,
      updateCamera: (camera) => {
        calls.push(`updateCamera near ${camera.near} far ${camera.far} eyes ${eyes.map((e) => tangentsOf(e.projectionMatrix).left).join(',')} reversed ${eyes.every(reversed)}`)
        // three: the headset's pose relative to the parent, and its own union read off the eyes' depth rows as WebGL's.
        camera.position.set(0.1, 1.6, 0)
        camera.rotation.set(-0.35, 0.52, 0, 'YXZ')
        camera.updateMatrixWorld(true)
        xrCamera.projectionMatrix.makePerspective(-1, 1, 1, -1, -0.3, 2)
        camera.fov = 123
      },
    },
    setAnimationLoop: () => {},
  }
  const compose = composerFor(renderer)
  const camera = new PerspectiveCamera(70, 1, 0.3, 500)
  compose(camera)
  assert.deepEqual(calls, ['updateCamera near 0.3 far 500 eyes -0.6,-0.4 reversed true'])
  const t = tangentsOf(camera.projectionMatrix)
  assert.ok(close(t.left, Math.tan(Math.atan(-0.6) - UNION_MARGIN)) && close(t.right, Math.tan(Math.atan(0.6) + UNION_MARGIN)))
  assert.deepEqual(xrCamera.projectionMatrix.elements, camera.projectionMatrix.elements, 'three culls and sorts with the same union')
  assert.deepEqual(xrCamera.projectionMatrixInverse.elements, camera.projectionMatrixInverse.elements)
  assert.equal(xrCamera.coordinateSystem, WebGPUCoordinateSystem)
  assert.equal(reversed(xrCamera), true)
  assert.ok(close(camera.fov, (180 / Math.PI) * 2 * Math.atan(1 / camera.projectionMatrix.elements[5])), 'the fov three\'s readers see is the union\'s')
  assert.equal(camera.zoom, 1)
  assert.ok(close(camera.position.y, 1.6) && close(camera.rotation.y, 0.52), 'the pose three composed is kept')
  // No eyes yet (the first frame before the headset posed): nothing but three's own composition.
  xrCamera.cameras = []
  const idle = new PerspectiveCamera(70, 1, 0.3, 500)
  const before = idle.projectionMatrix.clone()
  compose(idle)
  assert.deepEqual(idle.projectionMatrix.elements, before.elements)
})

test('the session: asked for synchronously with the webgpu feature; the loop before setSession, the end listener after; sources, select, frames; exit ends it and the end gives everything back', async () => {
  const session = new FakeSession()
  const left = controller('left'), pinch = pinchSource()
  session.inputSources = [left, pinch]
  const { xr, asked } = fakeXr({ session: () => Promise.resolve(session) })
  const r = fakeRenderer(), h = fakeHost(), m = new XrMapper()
  const p = new XrPresence(xr, r, h.host, m, () => true)
  assert.equal(p.possible, true)
  assert.equal(p.state, 'off')
  assert.equal(p.presenting, false)
  assert.deepEqual(await p.supported(), { vr: true, ar: false })
  assert.equal(p.describe(), 'off')
  const entering = p.enter('immersive-vr')
  assert.equal(asked.length, 1, 'asked before any await: inside the user activation')
  assert.deepEqual(asked[0], { mode: 'immersive-vr', init: { requiredFeatures: [...XR_FEATURES.required], optionalFeatures: [...XR_FEATURES.optional] } })
  assert.deepEqual([...XR_FEATURES.required], ['webgpu'])
  assert.equal(p.state, 'entering')
  assert.equal(p.describe(), 'entering')
  assert.equal(await p.enter('immersive-vr'), 'entering', 'a second ask meanwhile is not a second request')
  assert.equal(asked.length, 1)
  assert.equal(await entering, 'vr: on')
  assert.equal(p.state, 'vr')
  assert.equal(p.presenting, true)
  assert.equal(p.blendMode, 'opaque')
  assert.deepEqual(r.log, ['loop set', 'setSession loop=set enabled=true auto=false'])
  assert.equal(r.xr.enabled, true)
  assert.equal(r.xr.cameraAutoUpdate, false)
  assert.deepEqual([session.has('end'), session.has('inputsourceschange'), session.has('select')], [1, 1, 1])
  assert.deepEqual(h.events, ['sources 2', 'started immersive-vr opaque'])
  assert.equal(m.sources, session.inputSources, 'the mapper reads the live list')
  assert.equal(p.describe(), 'vr: 1 controller, 1 pinch')
  assert.equal(await p.enter('immersive-ar'), 'vr: already on')
  // The headset's loop drives the frame.
  r.tick(16)
  r.tick(32)
  assert.deepEqual(h.frames, [16, 32])
  // Sources change; a pinch selects, a controller does not (the mapper reads its buttons).
  session.inputSources = [left]
  session.fire('inputsourceschange', { added: [], removed: [pinch] })
  assert.equal(h.events.at(-1), 'sources 1')
  session.fire('select', { inputSource: pinch })
  session.fire('select', { inputSource: left })
  assert.deepEqual(h.events.filter((e) => e.startsWith('select')), ['select transient-pointer'])
  assert.equal(p.describe(), 'vr: 1 controller')
  // Exit: end() asked once; the 'end' event then does the rest.
  m.sources = session.inputSources
  m.read()
  await p.exit()
  assert.equal(session.ended, 1)
  await settle()
  assert.equal(p.state, 'off')
  assert.equal(p.presenting, false)
  assert.equal(r.log.at(-1), 'loop null')
  assert.equal(r.loop, null)
  assert.equal(r.xr.enabled, false)
  assert.equal(session.has('end') + session.has('select') + session.has('inputsourceschange'), 0, 'every listener removed')
  assert.deepEqual(h.events.slice(-2), ['sources null', 'ended'])
  assert.equal(m.sources, null)
  assert.equal(p.describe(), 'off')
  await p.exit()
  assert.equal(session.ended, 1, 'nothing to end twice')
  session.fire('end', {})
  assert.deepEqual(h.events.slice(-2), ['sources null', 'ended'], 'a late end event does nothing')
})

test('refusals: no WebXR, no binding, the browser throwing or rejecting, a session without the webgpu feature, setSession failing; each leaves the page as it was', async () => {
  const r = fakeRenderer(), h = fakeHost(), m = new XrMapper()
  const none = new XrPresence(null, r, h.host, m, () => true)
  assert.equal(none.possible, false)
  assert.equal(none.state, 'unsupported')
  assert.equal(none.describe(), 'unsupported')
  assert.equal(await none.enter('immersive-vr'), 'no headset: this browser has no WebXR')
  assert.deepEqual(await none.supported(), { vr: false, ar: false })
  const unbound = new XrPresence(fakeXr().xr, r, h.host, m, () => false)
  assert.equal(unbound.state, 'unsupported')
  assert.equal(await unbound.enter('immersive-vr'), 'no headset: this browser does not bind WebXR to WebGPU (XRGPUBinding)')
  assert.deepEqual(await unbound.supported(), { vr: false, ar: false })
  const throws = new XrPresence(fakeXr({ throws: 'SecurityError: no user activation' }).xr, r, h.host, m, () => true)
  assert.equal(await throws.enter('immersive-vr'), 'headset refused: SecurityError: no user activation')
  assert.equal(throws.state, 'off')
  const rejects = new XrPresence(fakeXr({ session: () => Promise.reject(new Error('NotSupportedError')) }).xr, r, h.host, m, () => true)
  assert.equal(await rejects.enter('immersive-ar'), 'headset refused: NotSupportedError')
  assert.equal(rejects.state, 'off')
  const bare = new FakeSession()
  bare.enabledFeatures = ['local-floor']
  const noFeature = new XrPresence(fakeXr({ session: () => Promise.resolve(bare) }).xr, r, h.host, m, () => true)
  assert.equal(await noFeature.enter('immersive-vr'), 'headset refused: the session came without the webgpu feature')
  assert.equal(bare.ended, 1, 'the useless session is ended')
  assert.equal(noFeature.state, 'off')
  assert.deepEqual(r.log, [], 'the renderer was never touched')
  assert.deepEqual(h.events, [])
  // setSession failing: the loop is given back, the rows cleared, the session ended, the state off.
  const s2 = new FakeSession()
  r.refuse = 'XRGPUBinding failed'
  const failing = new XrPresence(fakeXr({ session: () => Promise.resolve(s2) }).xr, r, h.host, m, () => true)
  assert.equal(await failing.enter('immersive-vr'), 'headset refused: XRGPUBinding failed')
  assert.deepEqual(r.log, ['loop set', 'setSession loop=set enabled=true auto=false', 'loop null'])
  assert.equal(r.xr.enabled, false)
  assert.equal(s2.ended, 1)
  assert.equal(s2.has('end'), 0)
  assert.equal(failing.state, 'off')
  assert.deepEqual(h.events, ['sources 0', 'sources null'])
  assert.equal(m.sources, null)
})

test('AR with passthrough, a cancel while entering, the headset ending the session itself, and dispose', async () => {
  const r = fakeRenderer(), h = fakeHost(), m = new XrMapper()
  const slow = new FakeSession()
  let resolve!: (v: XrSessionLike) => void
  const p = new XrPresence(fakeXr({ ar: true, session: () => new Promise((res) => { resolve = res }) }).xr, r, h.host, m, () => true)
  assert.deepEqual(await p.supported(), { vr: true, ar: true })
  const first = p.enter('immersive-ar')
  assert.equal(p.state, 'entering')
  await p.exit()
  assert.equal(p.state, 'off', 'exit while entering withdraws the wish')
  resolve(slow)
  assert.equal(await first, 'headset: cancelled')
  assert.equal(slow.ended, 1)
  assert.deepEqual(r.log, [])
  const s3 = new FakeSession()
  s3.environmentBlendMode = 'alpha-blend'
  s3.enabledFeatures = undefined
  const q = new XrPresence(fakeXr({ ar: true, session: () => Promise.resolve(s3) }).xr, r, h.host, m, () => true)
  assert.equal(await q.enter('immersive-ar'), 'ar: on')
  assert.equal(q.state, 'ar')
  assert.equal(q.blendMode, 'alpha-blend')
  assert.equal(q.describe(), 'ar (passthrough): no input yet')
  assert.equal(h.events.at(-1), 'started immersive-ar alpha-blend')
  s3.fire('end', {})
  assert.equal(q.state, 'off')
  assert.equal(q.blendMode, 'opaque')
  assert.deepEqual(h.events.slice(-2), ['sources null', 'ended'])
  assert.equal(r.loop, null)
  assert.equal(s3.ended, 0, 'the headset ended it; the page does not end it again')
  const s4 = new FakeSession()
  const d = new XrPresence(fakeXr({ session: () => Promise.resolve(s4) }).xr, r, h.host, m, () => true)
  assert.equal(await d.enter('immersive-vr'), 'vr: on')
  d.dispose()
  assert.equal(s4.ended, 1)
  await settle()
  assert.equal(d.state, 'off')
})

test('xrSystemOf, hasWebGpuBinding, immersiveModes and headsetPossible: shape checks that never throw', async () => {
  assert.equal(xrSystemOf(undefined), null)
  assert.equal(xrSystemOf(null), null)
  assert.equal(xrSystemOf({}), null)
  assert.equal(xrSystemOf({ xr: { isSessionSupported: 1 } }), null)
  const { xr } = fakeXr({ vr: true, ar: false })
  assert.equal(xrSystemOf({ xr }), xr)
  assert.equal(hasWebGpuBinding({}), false)
  assert.equal(hasWebGpuBinding({ XRGPUBinding: class {} }), true)
  const bound = { XRGPUBinding: class {} }
  assert.deepEqual(await immersiveModes(xr, {}), { vr: false, ar: false }, 'no binding: nothing')
  assert.deepEqual(await immersiveModes(xr, bound), { vr: true, ar: false })
  assert.deepEqual(await sessionModes(xr), { vr: true, ar: false }, 'the binding taken for granted (XrPresence checks it itself)')
  assert.deepEqual(await immersiveModes(null, bound), { vr: false, ar: false })
  const odd: XrSystemLike = { isSessionSupported: () => { throw new TypeError('odd') }, requestSession: () => Promise.reject(new Error('no')) }
  assert.deepEqual(await immersiveModes(odd, bound), { vr: false, ar: false })
  const rejecting: XrSystemLike = { isSessionSupported: () => Promise.reject(new Error('no')), requestSession: () => Promise.reject(new Error('no')) }
  assert.deepEqual(await immersiveModes(rejecting, bound), { vr: false, ar: false })
  assert.equal(await headsetPossible({ xr }, bound), true)
  assert.equal(await headsetPossible({ xr }, {}), false)
  assert.equal(await headsetPossible(undefined, bound), false)
  assert.equal(hasWebGpuBinding(), typeof (globalThis as { XRGPUBinding?: unknown }).XRGPUBinding !== 'undefined')
})

// ── The pinch: selectstart, the frames between, select and selectend ──────────────────────────────────────────────

type P3 = { x: number; y: number; z: number }
/** A frame posing each space at a point (absent: untracked); the viewer at `head`, or throwing as an event's frame does. */
function poseFrame(at: Map<unknown, P3>, head: P3 | null | 'throws') {
  return {
    getPose: (space: unknown, base: unknown) => {
      if (base !== REF) throw new Error('posed against the wrong space')
      const p = at.get(space)
      return p ? { transform: { position: p } } : null
    },
    getViewerPose: (base: unknown) => {
      if (head === 'throws') throw new Error('InvalidStateError')
      if (base !== REF) throw new Error('posed against the wrong space')
      return head ? { transform: { position: head } } : null
    },
  }
}
const REF = { kind: 'the reference space', listeners: new Set<() => void>(), addEventListener(_t: 'reset', l: () => void) { this.listeners.add(l) }, removeEventListener(_t: 'reset', l: () => void) { this.listeners.delete(l) } }

/** The renderer with a reference space (null until setSession), its type, and a loop given a frame. */
function spaceRenderer() {
  const r = fakeRenderer()
  let ref: unknown = null
  const types: string[] = []
  let frame: unknown = null
  const xr = r.xr as typeof r.xr & { getReferenceSpace: () => unknown; setReferenceSpaceType: (t: string) => void }
  const setSession = xr.setSession
  xr.setSession = (s) => setSession(s).then(() => { ref = REF })
  xr.getReferenceSpace = () => ref
  xr.setReferenceSpaceType = (t) => { types.push(t) }
  xr.getFrame = () => frame
  const loop = () => (r.loop as unknown as ((t: number, f?: unknown) => void) | null)
  return {
    r, types,
    dropSpace: () => { ref = null },
    tick: (t: number, f: unknown) => { frame = f; loop()?.(t, f); frame = null },
  }
}
/** A hand: a tracked pointer with a hand, a one-button xr-standard gamepad (its pinch) and a grip. */
const handSource = (handedness: 'left' | 'right'): XrInputSourceLike => ({ handedness, targetRayMode: 'tracked-pointer', profiles: [], hand: {}, gamepad: { mapping: 'xr-standard', axes: [], buttons: [{ pressed: false, value: 0 }] }, gripSpace: { grip: handedness }, targetRaySpace: { ray: handedness } })
/** A gaze-and-pinch pointer: transient, no mapping, its grip at the pinching fingers. */
const transient = (): XrInputSourceLike => ({ handedness: 'none', targetRayMode: 'transient-pointer', profiles: [], gamepad: { mapping: '', axes: [], buttons: [{ pressed: true, value: 1 }] }, gripSpace: { grip: 'fingers' }, targetRaySpace: { ray: 'gaze' } })

async function presenting(sources: XrInputSourceLike[], features: readonly string[] | undefined = ['webgpu', 'local-floor']) {
  const session = new FakeSession()
  session.inputSources = sources
  session.enabledFeatures = features
  const { xr } = fakeXr({ session: () => Promise.resolve(session) })
  const s = spaceRenderer(), h = fakeHost(), m = new XrMapper()
  let now = 0
  const p = new XrPresence(xr, s.r, h.host, m, () => true, () => now)
  assert.equal(await p.enter('immersive-vr'), 'vr: on')
  return { session, s, h, m, p, at: (t: number) => { now = t }, selects: () => h.events.filter((e) => e.startsWith('select')).length }
}
const HEADP: P3 = { x: 0, y: 1.6, z: 0 }

test('a quick still pinch of a hand taps once, in the event\'s own frame; a drag walks the mapper and never taps; a controller is never a pinch', async () => {
  const hand = handSource('right'), ctl = controller('left')
  const t = await presenting([hand, ctl])
  assert.deepEqual([t.session.has('selectstart'), t.session.has('select'), t.session.has('selectend'), t.session.has('visibilitychange'), REF.listeners.size], [1, 1, 1, 1, 1])
  const grip = hand.gripSpace
  // A tap that starts and ends between two headset frames (a pinch quicker than a frame): the events' frames carry it.
  t.at(100)
  t.session.fire('selectstart', { inputSource: hand, frame: poseFrame(new Map([[grip, { x: 0.2, y: 1.1, z: -0.3 }]]), 'throws') })
  t.at(180)
  t.session.fire('select', { inputSource: hand, frame: poseFrame(new Map([[grip, { x: 0.205, y: 1.1, z: -0.3 }]]), 'throws') })
  t.session.fire('selectend', { inputSource: hand, frame: poseFrame(new Map(), 'throws') })
  assert.equal(t.selects(), 1, 'one tap')
  assert.equal(t.m.pinches.size, 0)
  // A drag: pinch, then the headset frames move the hand forward against the head; the release is no tap.
  t.at(1000)
  t.session.fire('selectstart', { inputSource: hand, frame: poseFrame(new Map([[grip, { x: 0.2, y: 1.1, z: -0.3 }]]), 'throws') })
  t.s.tick(1011, poseFrame(new Map([[grip, { x: 0.2, y: 1.1, z: -0.3 }]]), HEADP))
  t.s.tick(1022, poseFrame(new Map([[grip, { x: 0.2, y: 1.1, z: -0.45 }]]), HEADP))
  t.m.sources = t.session.inputSources
  t.m.read()
  assert.ok(t.m.analog.moveY > 0.9, `the drag walks: ${t.m.analog.moveY}`)
  assert.deepEqual(t.h.frames, [1011, 1022], 'the engine\'s frame still runs after the sample')
  t.at(1300)
  t.session.fire('select', { inputSource: hand, frame: poseFrame(new Map([[grip, { x: 0.2, y: 1.1, z: -0.45 }]]), 'throws') })
  t.session.fire('selectend', { inputSource: hand })
  assert.equal(t.selects(), 1, 'a drag never taps')
  t.m.read()
  assert.equal(t.m.analog.moveY, 0, 'let go: still')
  // A controller's trigger fires select too: the mapper reads its buttons, so the session takes no pinch from it.
  t.session.fire('selectstart', { inputSource: ctl })
  t.session.fire('select', { inputSource: ctl })
  assert.equal(t.selects(), 1)
  assert.equal(t.m.pinches.size, 0)
  await t.p.exit()
  await settle()
  assert.equal(REF.listeners.size, 0, 'the recentre listener goes with the session')
})

test('a pinch cancelled (selectend with no select), one whose hand left, one held through the menu or a recentre: no tap, no walk on', async () => {
  const hand = handSource('left'), pinch = transient()
  const t = await presenting([hand, pinch])
  const grip = hand.gripSpace
  const start = (src: XrInputSourceLike) => t.session.fire('selectstart', { inputSource: src, frame: poseFrame(new Map([[src.gripSpace, { x: 0, y: 1.1, z: -0.3 }]]), 'throws') })
  const release = (src: XrInputSourceLike) => { t.session.fire('select', { inputSource: src, frame: poseFrame(new Map([[src.gripSpace, { x: 0, y: 1.1, z: -0.3 }]]), 'throws') }); t.session.fire('selectend', { inputSource: src }) }
  start(hand)
  t.session.fire('selectend', { inputSource: hand })
  assert.equal(t.m.pinches.size, 0, 'cancelled: forgotten')
  assert.equal(t.selects(), 0)
  // The hand leaves view mid-pinch: the sources change drops it.
  start(hand)
  t.session.inputSources = [pinch]
  t.session.fire('inputsourceschange', { added: [], removed: [hand] })
  assert.equal(t.m.pinches.size, 0, 'its source left: dropped')
  // The session's menu over the city: a drag held through it is dropped, and its later release is no tap.
  t.session.inputSources = [hand, pinch]
  start(hand)
  t.s.tick(16, poseFrame(new Map([[grip, { x: 0, y: 1.1, z: -0.3 }]]), HEADP))
  t.s.tick(32, poseFrame(new Map([[grip, { x: 0, y: 1.1, z: -0.5 }]]), HEADP))
  ;(t.session as { visibilityState?: string }).visibilityState = 'visible-blurred'
  t.session.fire('visibilitychange', {})
  t.m.read()
  assert.equal(t.m.analog.moveY, 0, 'behind the menu: no walking on')
  release(hand)
  assert.equal(t.selects(), 0, 'and no tap when let go')
  ;(t.session as { visibilityState?: string }).visibilityState = 'visible'
  t.session.fire('visibilitychange', {})
  // A recentre moves the space's origin under a held pinch: dropped.
  start(pinch)
  for (const l of REF.listeners) l()
  release(pinch)
  assert.equal(t.selects(), 0, 'a recentre drops it')
  // A transient pointer's quick pinch taps (its release jump is not counted).
  start(pinch)
  t.session.fire('select', { inputSource: pinch, frame: poseFrame(new Map([[pinch.gripSpace, { x: 0.05, y: 1.1, z: -0.3 }]]), 'throws') })
  assert.equal(t.selects(), 1)
  t.session.fire('selectend', { inputSource: pinch })
  // No reference space (a renderer without one) and untracked poses: a pinch is a tap only when quick, never a drag.
  t.s.dropSpace()
  start(hand)
  t.s.tick(48, poseFrame(new Map(), HEADP))
  t.m.read()
  assert.equal(t.m.analog.moveY, 0)
  t.session.fire('select', { inputSource: hand })
  t.session.fire('selectend', { inputSource: hand })
  assert.equal(t.selects(), 1, 'no poses at all: maybe a hand leaving view, so no tap')
  await t.p.exit()
  await settle()
  assert.deepEqual([t.session.has('selectstart'), t.session.has('select'), t.session.has('selectend'), t.session.has('visibilitychange'), REF.listeners.size], [0, 0, 0, 0, 0], 'every listener removed')
  assert.equal(t.m.pinches.size, 0)
})

test('a phone screen and a gaze button tap on any press; the floor: local-floor when granted, else local and floorless; describe counts hands', async () => {
  const screen: XrInputSourceLike = { handedness: 'none', targetRayMode: 'screen', profiles: [], gamepad: { mapping: '', axes: [0.1, -0.2], buttons: [{ pressed: true, value: 1 }] } }
  const gaze: XrInputSourceLike = { handedness: 'none', targetRayMode: 'gaze', profiles: [], gamepad: null }
  const t = await presenting([screen, gaze])
  assert.deepEqual(t.s.types, ['local-floor'])
  assert.equal(t.p.floorless, false)
  t.at(0)
  t.session.fire('selectstart', { inputSource: screen })
  t.at(5000)
  t.session.fire('select', { inputSource: screen })
  t.session.fire('selectstart', { inputSource: gaze })
  t.session.fire('select', { inputSource: gaze })
  assert.equal(t.selects(), 2, 'a long press of the screen still taps')
  assert.equal(t.p.describe(), 'vr: 2 pinches')
  const u = await presenting([handSource('left'), handSource('right'), controller('right')], ['webgpu'])
  assert.deepEqual(u.s.types, ['local'], 'the floor withheld: a plain local space, never a refusal')
  assert.equal(u.p.floorless, true)
  assert.equal(u.p.describe(), 'vr: 1 controller, 2 hands')
  await u.p.exit()
  await settle()
  assert.equal(u.p.floorless, false)
  const v = await presenting([], undefined)
  assert.deepEqual(v.s.types, ['local-floor'], 'a browser that lists no features: three\'s own floor')
  assert.equal(v.p.describe(), 'vr: no input yet')
  await t.p.exit()
  await v.p.exit()
  await settle()
  assert.equal(REF.listeners.size, 0)
})
