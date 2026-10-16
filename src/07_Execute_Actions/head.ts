// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the head the camera is locked to — first person only: at eye level on
 * foot, in the driver's seat in a car — posed like a physical head (yaw and pitch, never roll, no bob) so a
 * WebXR headset can take over. It runs on the page and reads only plain numbers (the avatar's feet, a car's
 * pose) from the physics worker's state.
 * What breaks if it is removed? The camera has nowhere to be.
 */
import type { PerspectiveCamera } from 'three/webgpu'
import { clampPitch } from '../04_Connect_Hardware/input.ts'

/** Input clamps look to it; defined beside the look tuning so the hardware stage imports nothing from here. */
export { PITCH_LIMIT } from '../04_Connect_Hardware/input.ts'

/** Eye above the feet, standing, m: the eye of the crowd's reference body (03_Spawn_Agents/look.ts heightScale 1). */
export const EYE_HEIGHT = 1.7
/** The eye may be set this far above the feet, m (the wardrobe's shortest and tallest bodies lie well inside). */
export const EYE_RANGE: readonly [number, number] = Object.freeze([1.2, 2.2] as [number, number])
/**
 * The eye height of a body drawn at `scale` times the reference height (look.ts heightScale): EYE_HEIGHT scaled,
 * held within EYE_RANGE; a non-finite scale is the reference eye.
 */
export function eyeHeightFor(scale: number): number {
  const h = EYE_HEIGHT * scale
  if (!Number.isFinite(h)) return EYE_HEIGHT
  return h < EYE_RANGE[0] ? EYE_RANGE[0] : h > EYE_RANGE[1] ? EYE_RANGE[1] : h
}
/** Max |head yaw| relative to the car's nose while seated, rad (110°: a shoulder check, not a look back). */
export const HEAD_TURN_LIMIT = (110 * Math.PI) / 180
/**
 * Chassis-local eye point of the driver: +x forward, +y up, −z = left (the driver's side; right-hand
 * traffic). Against the sedan profile in fleetView.ts (chassis origin 0.56 m above the road): 1.18 m above the
 * road, about 0.22 m under the roof skin and 0.9 m behind the windscreen at eye level, over the left seat.
 */
export const DRIVER_EYE: { readonly x: number; readonly y: number; readonly z: number } = Object.freeze({ x: -0.1, y: 0.62, z: -0.36 })
/** The SUV is the sedan body scaled (1, 1.16, 1.03) about the chassis origin (fleetView.ts sync). */
const SUV_SCALE = { y: 1.16, z: 1.03 } as const
/** Eye-height easing on a step up or down, s (time constant). */
const STEP_EASE = 0.08
/** The eye never trails the body's height by more than this, m. */
const MAX_EYE_LAG = 0.3
/** A height change larger than this in one frame is a teleport or a car exit: the eye snaps, m. */
const SNAP = 1
const TAU = Math.PI * 2

/** An angle wrapped into [−π, π). */
const wrap = (a: number) => a - TAU * Math.floor((a + Math.PI) / TAU)

export interface HeadPose { x: number; y: number; z: number; yaw: number; pitch: number }

/** A ray from the eye along the head forward: origin (ox, oy, oz) and unit direction (dx, dy, dz), world space. */
export interface AimRay { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number }

/**
 * The look ray of a head pose, written into `out`: origin = the eye, direction = the head forward the camera is
 * posed with, (−sin yaw·cos pitch, sin pitch, −cos yaw·cos pitch), so a ray and the view can never disagree.
 * A non-finite angle gives the direction (0, 0, −1); a non-finite eye coordinate leaves the origin as it was.
 * Allocation-free.
 */
export function aimRay(pose: HeadPose, out: AimRay): AimRay {
  if (Number.isFinite(pose.x) && Number.isFinite(pose.y) && Number.isFinite(pose.z)) { out.ox = pose.x; out.oy = pose.y; out.oz = pose.z }
  if (Number.isFinite(pose.yaw) && Number.isFinite(pose.pitch)) {
    const cp = Math.cos(pose.pitch)
    out.dx = -Math.sin(pose.yaw) * cp
    out.dy = Math.sin(pose.pitch)
    out.dz = -Math.cos(pose.yaw) * cp
  } else {
    out.dx = 0; out.dy = 0; out.dz = -1
  }
  return out
}

/**
 * The camera is the avatar's head: world eye position plus yaw and pitch, applied to the camera as
 * (pitch, yaw, 0, 'YXZ') — head forward = (−sin yaw·cos pitch, sin pitch, −cos yaw·cos pitch). No roll and
 * no head bob (comfort, and the headset owns both under WebXR). Allocation-free per frame.
 */
export class HeadRig {
  /** World eye position and head angles last applied — what a future WebXR layer reads or overrides. */
  readonly pose: HeadPose = { x: 0, y: EYE_HEIGHT, z: 0, yaw: 0, pitch: 0 }
  /** Eased eye height on foot. */
  private eyeY = EYE_HEIGHT
  /** The next onFoot() snaps (first frame, or the last pose was the driver's seat). */
  private snap = true
  /** How far above the feet this head's eye sits, m (setEyeHeight: the body's own height from the wardrobe). */
  private eye = EYE_HEIGHT

  /**
   * Sets the eye's height above the feet, m, held within EYE_RANGE (a non-finite value leaves it). The change is
   * eased in like a step (STEP_EASE), never snapped, so a slider dragged in the wardrobe moves the view smoothly.
   */
  setEyeHeight(metres: number): number {
    if (Number.isFinite(metres)) this.eye = metres < EYE_RANGE[0] ? EYE_RANGE[0] : metres > EYE_RANGE[1] ? EYE_RANGE[1] : metres
    return this.eye
  }

  /** The eye's height above the feet, m. */
  get eyeHeight(): number {
    return this.eye
  }

  /** Eye `eyeHeight` above the avatar's feet. Vertical steps (curbs) are smoothed; horizontal motion never is. */
  onFoot(camera: PerspectiveCamera, feetX: number, feetY: number, feetZ: number, yaw: number, pitch: number, dt: number): void {
    const target = feetY + this.eye
    if (Number.isFinite(target)) {
      if (this.snap || !(Math.abs(target - this.eyeY) < SNAP)) {
        this.eyeY = target
      } else if (dt > 0) {
        const y = this.eyeY + (target - this.eyeY) * (1 - Math.exp(-dt / STEP_EASE))
        this.eyeY = y < target - MAX_EYE_LAG ? target - MAX_EYE_LAG : y > target + MAX_EYE_LAG ? target + MAX_EYE_LAG : y
      }
      this.snap = false
    }
    this.apply(camera, feetX, this.eyeY, feetZ, yaw, pitch)
  }

  /**
   * Eye at DRIVER_EYE carried by the chassis pose (SUV eye raised by the SUV's 1.16 body scale, and moved out
   * with its 1.03 width). The head stays level: the chassis carries the eye point, never the view's roll.
   */
  inVehicle(camera: PerspectiveCamera, pos: { x: number; y: number; z: number }, rot: { x: number; y: number; z: number; w: number }, suv: boolean, yaw: number, pitch: number): void {
    const ex = DRIVER_EYE.x
    const ey = DRIVER_EYE.y * (suv ? SUV_SCALE.y : 1)
    const ez = DRIVER_EYE.z * (suv ? SUV_SCALE.z : 1)
    // v' = v + w·t + q×t with t = 2·(q×v): the eye offset rotated by the chassis quaternion.
    const qx = rot.x, qy = rot.y, qz = rot.z, qw = rot.w
    const tx = 2 * (qy * ez - qz * ey), ty = 2 * (qz * ex - qx * ez), tz = 2 * (qx * ey - qy * ex)
    this.snap = true
    this.apply(
      camera,
      pos.x + ex + qw * tx + (qy * tz - qz * ty),
      pos.y + ey + qw * ty + (qz * tx - qx * tz),
      pos.z + ez + qw * tz + (qx * ty - qy * tx),
      yaw, pitch,
    )
  }

  private apply(camera: PerspectiveCamera, x: number, y: number, z: number, yaw: number, pitch: number): void {
    const pose = this.pose
    // A broken input (NaN) holds the last good head pose instead of blanking the view.
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) { pose.x = x; pose.y = y; pose.z = z }
    if (Number.isFinite(yaw)) pose.yaw = yaw
    if (Number.isFinite(pitch)) pose.pitch = clampPitch(pitch)
    camera.position.set(pose.x, pose.y, pose.z)
    camera.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ')
    camera.updateMatrixWorld()
  }
}

/** World head yaw carried by a turning car: adds the car's heading change, then clamps the head within ±limit of the nose. */
export function carriedYaw(yaw: number, prevHeading: number, heading: number, limit: number = HEAD_TURN_LIMIT): number {
  const turn = wrap(heading - prevHeading)
  const carried = yaw + (Number.isFinite(turn) ? turn : 0)
  const lim = limit > 0 ? limit : 0
  const rel = wrap(carried - yawFacing(heading))
  // Only the excess is taken off, so the yaw stays continuous (never jumps by 2π).
  if (rel > lim) return carried - (rel - lim)
  if (rel < -lim) return carried - (rel + lim)
  return carried
}

/** Head yaw looking straight along a heading, forward (sin h, cos h): sitting down facing the windscreen. */
export function yawFacing(heading: number): number {
  return heading + Math.PI
}
