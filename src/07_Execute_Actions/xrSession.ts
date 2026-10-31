// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the headset session: WebXR (immersive-web.github.io/webxr) over the page's own
 * WebGPU device, through three's XRManager (renderer.xr) and its XRGPUBinding. It asks the browser for an
 * `immersive-vr` or `immersive-ar` session with the `webgpu` feature (three refuses a WebGPU renderer a session
 * without it), hands the engine's frame to the headset's own loop, hands the session's input sources to the headset
 * mapper (04_Connect_Hardware/xrInput.ts) and the HAL's rows, turns a pinch into an action, and composes the
 * headset's pose onto the head rig (head.ts setHeadset): every eye's projection is rewritten as the page's own
 * (WebGPU clip space, reversed depth, the camera's near and far: three copies the browser's matrices raw and skips
 * its reversed-depth fix-up while presenting), and the eyes' union, widened, becomes the projection the engine and
 * three's own XR camera cull with. It ends cleanly: the loop given back to the page, the renderer's XR off, the
 * head rig its own again.
 * Everything here is written against three 0.186's XRManager and the WebXR specifications and proven only against
 * fakes: UNCONFIRMED on a physical headset, where the depth convention of a WebGPU session's projection matrices,
 * the pinch timing of a gaze-and-pinch headset and the passthrough blend have not been seen.
 * What breaks if it is removed? The city has no headset: the head rig stays the mouse's and the pad's.
 */

import { Matrix4, WebGPUCoordinateSystem, type PerspectiveCamera } from 'three/webgpu'
import type { XrInputSourceLike, XrSessionLike, XrSessionMode, XrSystemLike } from '../04_Connect_Hardware/web-hardware.d.ts'
import { isPointerOnly, isTrackedController, type XrMapper } from '../04_Connect_Hardware/xrInput.ts'
import { hasWebGpuBinding, sessionModes, type XrState } from '../04_Connect_Hardware/xrSystem.ts'
import type { HeadCompose } from './head.ts'

/** The session's features: `webgpu` is what three's WebGPU path needs; the rest are optional comforts. */
export const XR_FEATURES = Object.freeze({
  required: Object.freeze(['webgpu']),
  optional: Object.freeze(['local-floor', 'bounded-floor', 'hand-tracking']),
})

/** The cull's union frustum is this much wider than the eyes on every side, rad (the eyes sit a few cm apart). */
export const UNION_MARGIN = (4 * Math.PI) / 180

/** An eye camera of three's XR manager, as far as the slice touches it (a PerspectiveCamera satisfies it). */
export interface EyeCameraLike {
  readonly projectionMatrix: Matrix4
  readonly projectionMatrixInverse: Matrix4
  coordinateSystem: number
}

/** What the slice asks of three's renderer.xr (XRManager) and of the renderer. */
export interface XrManagerLike {
  enabled: boolean
  /** Off here: the head rig composes the headset's pose itself (head.ts), so the cull and the audio see it this frame. */
  cameraAutoUpdate: boolean
  setSession(session: XrSessionLike): Promise<void>
  /** The headset frame being drawn, non-null only inside the headset's loop. */
  getFrame(): unknown
  /** three's own XR camera: the eyes under `cameras`, and the camera three culls and sorts with while presenting. */
  getCamera(): XrCameraLike
  updateCamera(camera: PerspectiveCamera): void
}

/** three's XR camera (an ArrayCamera): a camera of its own over the eye cameras. */
export interface XrCameraLike extends EyeCameraLike {
  readonly cameras: readonly EyeCameraLike[]
}

export interface XrRendererLike {
  readonly xr: XrManagerLike
  setAnimationLoop(callback: ((time: number) => void) | null): Promise<void> | void
}

/** What the session reaches of the engine. */
export interface XrHost {
  /** The frame, driven by the headset's loop while presenting (the engine's frame(nowMs)). */
  frame(nowMs: number): void
  /** The session's sources came or went (plugged, pinched): the HAL's headset rows; null when the session ends. */
  sources(list: ArrayLike<XrInputSourceLike> | null): void
  /** A select from a source with no usable gamepad: a pinch on a gaze-and-pinch headset, a hand. */
  select(source: XrInputSourceLike): void
  /** Presenting: `blend` is the session's environmentBlendMode ('opaque', 'alpha-blend' or 'additive'). */
  started(mode: XrSessionMode, blend: string): void
  ended(): void
}

export type { XrState } from '../04_Connect_Hardware/xrSystem.ts'

const errorText = (e: unknown): string => (e instanceof Error && e.message ? e.message : String(e))

/**
 * The frustum's tangents (left, right, top, bottom over near) read off a projection matrix, column-major as WebXR
 * and three keep them: m[0] = 2n/(r−l), m[8] = (r+l)/(r−l), m[5] = 2n/(t−b), m[9] = (t+b)/(t−b), whatever the depth
 * rows hold. False (nothing written) for a matrix that is no perspective.
 */
export function frustumTangents(m: ArrayLike<number>, out: { left: number; right: number; top: number; bottom: number }): boolean {
  const sx = m[0], sy = m[5], ox = m[8], oy = m[9]
  // m[11] is −1 for a perspective (w = −z) and 0 for an orthographic matrix, whose scales are positive too.
  if (!(sx > 0) || !(sy > 0) || !(m[11] < 0) || !Number.isFinite(ox) || !Number.isFinite(oy)) return false
  out.left = (ox - 1) / sx
  out.right = (ox + 1) / sx
  out.top = (oy + 1) / sy
  out.bottom = (oy - 1) / sy
  return true
}

const TANGENTS = { left: 0, right: 0, top: 0, bottom: 0 }

/**
 * Rewrites an eye's projection as the page's own: the browser's frustum (its asymmetric tangents) in WebGPU clip
 * space with reversed depth (world.ts createRenderer) between the camera's near and far, and marks the eye so three's
 * own frustum culling reads it that way. False, and nothing touched, when the projection is no perspective.
 */
export function reversedEyeProjection(eye: EyeCameraLike, near: number, far: number): boolean {
  const t = TANGENTS
  if (!frustumTangents(eye.projectionMatrix.elements, t)) return false
  eye.projectionMatrix.makePerspective(t.left * near, t.right * near, t.top * near, t.bottom * near, near, far, WebGPUCoordinateSystem, true)
  eye.projectionMatrixInverse.copy(eye.projectionMatrix).invert()
  eye.coordinateSystem = WebGPUCoordinateSystem
  ;(eye as { _reversedDepth?: boolean })._reversedDepth = true
  return true
}

/**
 * The camera's projection as the eyes' union, every side `margin` wider, reversed depth: what the engine culls and
 * sorts with (the render itself draws each eye with its own). False, and nothing touched, without a perspective eye.
 */
export function unionProjection(camera: PerspectiveCamera, eyes: readonly EyeCameraLike[], margin: number = UNION_MARGIN): boolean {
  const t = TANGENTS
  let l = Infinity, r = -Infinity, top = -Infinity, b = Infinity, n = 0
  for (const eye of eyes) {
    if (!frustumTangents(eye.projectionMatrix.elements, t)) continue
    n++
    if (t.left < l) l = t.left
    if (t.right > r) r = t.right
    if (t.top > top) top = t.top
    if (t.bottom < b) b = t.bottom
  }
  if (n === 0) return false
  const near = camera.near, far = camera.far
  const wide = (tan: number, outward: number) => Math.tan(Math.atan(tan) + outward)
  camera.projectionMatrix.makePerspective(wide(l, -margin) * near, wide(r, margin) * near, wide(top, margin) * near, wide(b, -margin) * near, near, far, WebGPUCoordinateSystem, true)
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  return true
}

/**
 * The head rig's composition for a renderer presenting to a headset: the eyes' projections made the page's own,
 * three's composition of the headset's pose under the rig (renderer.xr.updateCamera), then the cull's union on the
 * user camera and on three's own XR camera. three culls and sorts with that XR camera while presenting, with a
 * union it takes from the eyes' depth rows as WebGL's (nonsense over reversed ones) and a depth it never marks
 * reversed inside a session (its fix-up runs only outside one), so the XR camera is given the same union, marked;
 * the fov three set on the user camera from its own union is set from this one.
 */
export function composerFor(renderer: XrRendererLike): HeadCompose {
  return (camera) => {
    const xrCamera = renderer.xr.getCamera()
    const eyes = xrCamera.cameras
    for (let i = 0; i < eyes.length; i++) reversedEyeProjection(eyes[i], camera.near, camera.far)
    renderer.xr.updateCamera(camera)
    if (!unionProjection(camera, eyes)) return
    xrCamera.projectionMatrix.copy(camera.projectionMatrix)
    xrCamera.projectionMatrixInverse.copy(camera.projectionMatrixInverse)
    xrCamera.coordinateSystem = WebGPUCoordinateSystem
    ;(xrCamera as { _reversedDepth?: boolean })._reversedDepth = true
    camera.fov = (180 / Math.PI) * 2 * Math.atan(1 / camera.projectionMatrix.elements[5])
    camera.zoom = 1
  }
}

/** The session: asked for inside a user gesture, driven until the headset or the page ends it. */
export class XrPresence {
  private readonly xr: XrSystemLike | null
  private readonly renderer: XrRendererLike
  private readonly host: XrHost
  private readonly mapper: XrMapper
  private readonly binding: () => boolean
  private session: XrSessionLike | null = null
  private mode: XrSessionMode | null = null
  /** enter() ran and no end has come: a session is wanted (being asked for, or presenting). */
  private wanted = false
  private blend = 'opaque'
  private readonly loop = (time: number): void => { this.host.frame(time) }
  private readonly onSources = (): void => { const s = this.session; if (s) this.host.sources(s.inputSources) }
  private readonly onSelect = (e: { readonly inputSource: XrInputSourceLike }): void => {
    if (this.session && isPointerOnly(e.inputSource)) this.host.select(e.inputSource)
  }
  private readonly onEnd = (): void => { this.ended() }

  constructor(xr: XrSystemLike | null, renderer: XrRendererLike, host: XrHost, mapper: XrMapper, binding: () => boolean = () => hasWebGpuBinding()) {
    this.xr = xr
    this.renderer = renderer
    this.host = host
    this.mapper = mapper
    this.binding = binding
  }

  /** WebXR and the WebGPU binding are both here: a session can be asked for. */
  get possible(): boolean {
    return this.xr !== null && this.binding()
  }

  get state(): XrState {
    if (!this.possible) return 'unsupported'
    if (this.session) return this.mode === 'immersive-ar' ? 'ar' : 'vr'
    return this.wanted ? 'entering' : 'off'
  }

  /** A session is up: the headset drives the frames and composes the head. */
  get presenting(): boolean {
    return this.session !== null
  }

  /** The session's environmentBlendMode: 'opaque' for a VR headset, else passthrough or see-through. */
  get blendMode(): string {
    return this.blend
  }

  /** Which immersive modes the browser says it supports ({ vr: false, ar: false } without WebXR or the binding). */
  supported(): Promise<{ vr: boolean; ar: boolean }> {
    const xr = this.xr
    return xr && this.binding() ? sessionModes(xr) : Promise.resolve({ vr: false, ar: false })
  }

  /**
   * Asks for the session. Synchronous up to the browser's request, so call it inside a tap or a key press (the
   * user activation). Resolves to a status line: the mode on, or why not.
   */
  enter(mode: XrSessionMode): Promise<string> {
    if (!this.xr) return Promise.resolve('no headset: this browser has no WebXR')
    if (!this.binding()) return Promise.resolve('no headset: this browser does not bind WebXR to WebGPU (XRGPUBinding)')
    if (this.session) return Promise.resolve(`${this.state}: already on`)
    if (this.wanted) return Promise.resolve('entering')
    this.wanted = true
    let request: Promise<XrSessionLike>
    try {
      request = this.xr.requestSession(mode, { requiredFeatures: [...XR_FEATURES.required], optionalFeatures: [...XR_FEATURES.optional] })
    } catch (e) {
      this.wanted = false
      return Promise.resolve(`headset refused: ${errorText(e)}`)
    }
    return request.then(
      (session) => this.start(session, mode),
      (e) => { this.wanted = false; return `headset refused: ${errorText(e)}` },
    )
  }

  private async start(session: XrSessionLike, mode: XrSessionMode): Promise<string> {
    if (!this.wanted) { await session.end().catch(() => {}); return 'headset: cancelled' }
    const features = session.enabledFeatures
    if (features && !features.includes('webgpu')) {
      this.wanted = false
      await session.end().catch(() => {})
      return 'headset refused: the session came without the webgpu feature'
    }
    this.session = session
    this.mode = mode
    this.blend = typeof session.environmentBlendMode === 'string' ? session.environmentBlendMode : 'opaque'
    this.mapper.sources = session.inputSources
    session.addEventListener('inputsourceschange', this.onSources)
    session.addEventListener('select', this.onSelect)
    this.host.sources(session.inputSources)
    const r = this.renderer
    r.xr.enabled = true
    r.xr.cameraAutoUpdate = false
    // The loop is registered first: setSession captures the loop registered at that moment and stops the page's own
    // animation, then calls the captured loop once per headset frame.
    void r.setAnimationLoop(this.loop)
    try {
      await r.xr.setSession(session)
    } catch (e) {
      this.detach(session)
      this.wanted = false
      this.host.sources(null)
      await session.end().catch(() => {})
      return `headset refused: ${errorText(e)}`
    }
    if (this.session !== session) return 'headset: ended'
    // Listened to after setSession, so three's own end handler runs first (it gives the loop back to the page's
    // animation; ended() then takes it off).
    session.addEventListener('end', this.onEnd)
    this.host.started(mode, this.blend)
    return `${mode === 'immersive-ar' ? 'ar' : 'vr'}: on`
  }

  /** Ends the session (the 'end' event then does the rest); nothing without one. */
  exit(): Promise<void> {
    const s = this.session
    this.wanted = false
    if (!s) return Promise.resolve()
    return s.end().catch(() => {})
  }

  /** The session ended (by the page, the headset or the browser): the renderer and the head rig are the page's again. */
  private ended(): void {
    const s = this.session
    if (!s) return
    this.detach(s)
    this.wanted = false
    this.host.sources(null)
    this.host.ended()
  }

  private detach(session: XrSessionLike): void {
    const r = this.renderer
    void r.setAnimationLoop(null)
    r.xr.enabled = false
    session.removeEventListener('inputsourceschange', this.onSources)
    session.removeEventListener('select', this.onSelect)
    session.removeEventListener('end', this.onEnd)
    this.mapper.sources = null
    this.mapper.reset()
    this.session = null
    this.mode = null
    this.blend = 'opaque'
  }

  /** One line for the HUD and `hal`: off, entering, or the mode with what the session holds. */
  describe(): string {
    const s = this.session
    if (!s) return this.state
    let controllers = 0, pointers = 0
    const list = s.inputSources
    for (let i = 0; i < list.length; i++) { if (isTrackedController(list[i])) controllers++; else pointers++ }
    const parts: string[] = []
    if (controllers) parts.push(`${controllers} controller${controllers === 1 ? '' : 's'}`)
    if (pointers) parts.push(`${pointers} pinch${pointers === 1 ? '' : 'es'}`)
    return `${this.state}${this.blend !== 'opaque' ? ' (passthrough)' : ''}: ${parts.length ? parts.join(', ') : 'no input yet'}`
  }

  /** Page teardown: ends the session (the renderer is released right after). */
  dispose(): void {
    void this.exit()
  }
}
