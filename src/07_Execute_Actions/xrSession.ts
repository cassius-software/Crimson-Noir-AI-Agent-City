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
import type { XrFrameLike, XrInputSourceEventLike, XrInputSourceLike, XrReferenceSpaceLike, XrSessionLike, XrSessionMode, XrSystemLike } from '../04_Connect_Hardware/web-hardware.d.ts'
import { isPointerOnly, neckOf, pinchKindOf, type XrMapper, type XrPoint } from '../04_Connect_Hardware/xrInput.ts'
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
  /** The reference space three asked the session for (null until setSession has it): the pinch's poses are read in it. */
  getReferenceSpace?(): unknown
  /** The type of reference space setSession asks for ('local-floor' unless told otherwise). */
  setReferenceSpaceType?(type: string): void
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
  setAnimationLoop(callback: ((time: number, frame?: unknown) => void) | null): Promise<void> | void
}

/** What the session reaches of the engine. */
export interface XrHost {
  /** The frame, driven by the headset's loop while presenting (the engine's frame(nowMs)). */
  frame(nowMs: number): void
  /** The session's sources came or went (plugged, pinched): the HAL's headset rows; null when the session ends. */
  sources(list: ArrayLike<XrInputSourceLike> | null): void
  /** A tap from a source with no usable gamepad: a quick pinch on a gaze-and-pinch headset or of a hand, a screen tap. */
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
  /** The session was not granted 'local-floor': its space is 'local', whose origin is where the head began. */
  private noFloor = false
  /** The reference space listened to for a recentre, while presenting. */
  private space: XrReferenceSpaceLike | null = null
  private readonly clock: () => number
  private readonly loop = (time: number, frame?: unknown): void => {
    this.sample(frame as XrFrameLike | undefined, time)
    this.host.frame(time)
  }
  private readonly onSources = (): void => {
    const s = this.session
    if (!s) return
    // A pinch whose source has left (a hand out of view, a transient pointer let go) is dropped: no tap, no drag.
    const live = new Set<object>()
    for (let i = 0; i < s.inputSources.length; i++) live.add(s.inputSources[i])
    const gone: object[] = []
    for (const id of this.mapper.pinches.ids()) if (!live.has(id)) gone.push(id)
    for (const id of gone) this.mapper.pinches.cancel(id)
    this.host.sources(s.inputSources)
  }
  /** A pointer's pinch (or a screen's touch, a gaze button's press) begins: where its hand is now. */
  private readonly onSelectStart = (e: XrInputSourceEventLike): void => {
    const src = e.inputSource
    if (!this.session || !isPointerOnly(src)) return
    const kind = pinchKindOf(src)
    this.mapper.pinches.start(src, kind, src.targetRayMode === 'transient-pointer', this.clock(), kind === 'tap' ? null : this.handIn(e.frame, src))
  }
  /** It is let go: a tap when it was quick and still, which the engine acts on; nothing after a drag. */
  private readonly onSelect = (e: XrInputSourceEventLike): void => {
    const src = e.inputSource
    if (!this.session || !isPointerOnly(src)) return
    const kind = pinchKindOf(src)
    if (this.mapper.pinches.end(src, this.clock(), kind === 'tap' ? null : this.handIn(e.frame, src)) === 'tap') this.host.select(src)
  }
  /** It ended (after its select, or cancelled without one): forgotten. */
  private readonly onSelectEnd = (e: XrInputSourceEventLike): void => {
    if (isPointerOnly(e.inputSource)) this.mapper.pinches.cancel(e.inputSource)
  }
  /** The session's menu or a system prompt over the city: every pinch is dropped, so none walks on behind it. */
  private readonly onVisibility = (): void => {
    const s = this.session
    if (s && s.visibilityState !== undefined && s.visibilityState !== 'visible') this.mapper.pinches.clear()
  }
  /** A recentre moves the space's origin: a held drag would jump, so it is dropped. */
  private readonly onRecentre = (): void => { this.mapper.pinches.clear() }
  private readonly onEnd = (): void => { this.ended() }

  constructor(xr: XrSystemLike | null, renderer: XrRendererLike, host: XrHost, mapper: XrMapper, binding: () => boolean = () => hasWebGpuBinding(), clock: () => number = () => performance.now()) {
    this.xr = xr
    this.renderer = renderer
    this.host = host
    this.mapper = mapper
    this.binding = binding
    this.clock = clock
  }

  /** The reference space three holds, or null (before setSession has it, or a renderer without one). */
  private reference(): unknown {
    try { return this.renderer.xr.getReferenceSpace?.() ?? null } catch { return null }
  }

  /** Where a pointer's hand is in a frame: its grip, else (a tracked pointer with none) its ray; null untracked. */
  private handIn(frame: XrFrameLike | undefined, src: XrInputSourceLike): XrPoint | null {
    const ref = this.reference()
    if (!frame || !ref) return null
    const space = pinchKindOf(src) === 'grip' ? src.gripSpace : src.targetRaySpace
    if (space === undefined || space === null) return null
    try { return frame.getPose(space, ref)?.transform.position ?? null } catch { return null }
  }

  /** Each headset frame, before the engine's: every held pinch's hand, and the head, for the drag. */
  private sample(frame: XrFrameLike | undefined, time: number): void {
    const pinches = this.mapper.pinches
    if (pinches.size === 0 || !frame) return
    const ref = this.reference()
    let head: XrPoint | null = null
    // The neck, not the eyes: the eyes swing through centimetres as the head turns, and a look around must not walk.
    if (ref) { try { const v = frame.getViewerPose?.(ref); head = v ? neckOf(v.transform) : null } catch { head = null } }
    for (const id of pinches.ids()) {
      const src = id as XrInputSourceLike
      pinches.sample(id, time, pinchKindOf(src) === 'tap' ? null : this.handIn(frame, src), head)
    }
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

  /** Presenting in a space with no floor ('local'): the head rig stands its floor an eye's height above the feet. */
  get floorless(): boolean {
    return this.session !== null && this.noFloor
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
    session.addEventListener('selectstart', this.onSelectStart)
    session.addEventListener('select', this.onSelect)
    session.addEventListener('selectend', this.onSelectEnd)
    session.addEventListener('visibilitychange', this.onVisibility)
    this.host.sources(session.inputSources)
    const r = this.renderer
    r.xr.enabled = true
    r.xr.cameraAutoUpdate = false
    // three asks for a 'local-floor' space, which the session was only asked for as optional: where it was not
    // granted, a plain 'local' one (its origin where the head began, so the head rig lifts its floor by an eye's
    // height: floorless), or setSession would refuse every headset that withholds the floor. Set every session, so
    // one without the floor does not leave the next asking for 'local' too.
    this.noFloor = features !== undefined && !features.includes('local-floor')
    try { r.xr.setReferenceSpaceType?.(this.noFloor ? 'local' : 'local-floor') } catch { /* keeps three's own */ }
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
    const space = this.reference() as XrReferenceSpaceLike | null
    if (space && typeof space.addEventListener === 'function') { space.addEventListener('reset', this.onRecentre); this.space = space }
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
    session.removeEventListener('selectstart', this.onSelectStart)
    session.removeEventListener('select', this.onSelect)
    session.removeEventListener('selectend', this.onSelectEnd)
    session.removeEventListener('visibilitychange', this.onVisibility)
    session.removeEventListener('end', this.onEnd)
    this.space?.removeEventListener?.('reset', this.onRecentre)
    this.space = null
    this.mapper.sources = null
    this.mapper.reset()
    this.session = null
    this.mode = null
    this.blend = 'opaque'
    this.noFloor = false
  }

  /** One line for the HUD and `hal`: off, entering, or the mode with what the session holds. */
  describe(): string {
    const s = this.session
    if (!s) return this.state
    let controllers = 0, hands = 0, pointers = 0
    const list = s.inputSources
    for (let i = 0; i < list.length; i++) {
      const src = list[i]
      // A hand is one with joints, or one the browser names a hand without them (hand tracking not granted); any other
      // tracked pointer is a controller, read by its gamepad or (with no axes) by its pinch.
      if (src.hand || src.profiles.some((p) => p.startsWith('generic-hand'))) hands++
      else if (src.targetRayMode === 'tracked-pointer') controllers++
      else pointers++
    }
    const parts: string[] = []
    if (controllers) parts.push(`${controllers} controller${controllers === 1 ? '' : 's'}`)
    if (hands) parts.push(`${hands} hand${hands === 1 ? '' : 's'}`)
    if (pointers) parts.push(`${pointers} pinch${pointers === 1 ? '' : 'es'}`)
    return `${this.state}${this.blend !== 'opaque' ? ' (passthrough)' : ''}: ${parts.length ? parts.join(', ') : 'no input yet'}`
  }

  /** Page teardown: ends the session (the renderer is released right after). */
  dispose(): void {
    void this.exit()
  }
}
