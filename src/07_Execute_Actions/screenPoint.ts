// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is where a world point falls on the screen for a chip the HUD draws over the world (a
 * ping, the first walk's marker): 0..1 across and down the whole canvas, or NaN both ways when the camera does not see
 * it. The side is decided in view space (in front is z < 0 there) before the projection, because the renderer draws
 * with a reversed depth buffer (world.ts), under which a point behind the camera projects to a depth below 0 with x
 * and y mirrored: the clip test alone drew a mark behind the visitor as if it were ahead. In split screen the point is
 * placed in the camera's own viewport. Pure over three's camera matrices, so a node test can hold it to that.
 * What breaks if it is removed? The engine has no way to place a ping's or the marker's chip, and the bug comes back.
 */
import { Vector3, type Camera } from 'three'

/** A place on the screen, 0..1 across and down the whole canvas; NaN both ways when off screen. */
export interface ScreenPoint { readonly sx: number; readonly sy: number }

/** A viewport in the canvas's logical pixels, from its top left (viewports.ts splitScreen). */
export interface ScreenRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** No chip: behind the camera or outside its view. */
export const OFF_SCREEN: ScreenPoint = Object.freeze({ sx: Number.NaN, sy: Number.NaN })

const scratch = new Vector3()

/**
 * Where (x, y, z) falls on the screen through `camera` (its matrices as last updated). `view`, when given, is the
 * camera's viewport inside a canvas `width` x `height` (split screen); without it the camera fills the canvas.
 */
export function screenPoint(camera: Camera, x: number, y: number, z: number, view?: { rect: ScreenRect; width: number; height: number }): ScreenPoint {
  const v = scratch.set(x, y, z).applyMatrix4(camera.matrixWorldInverse)
  if (!(v.z < 0)) return OFF_SCREEN
  v.applyMatrix4(camera.projectionMatrix)
  if (!(Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1)) return OFF_SCREEN
  const fx = (v.x + 1) / 2, fy = (1 - v.y) / 2
  if (!view) return { sx: fx, sy: fy }
  const r = view.rect, w = Math.max(1, view.width), h = Math.max(1, view.height)
  return { sx: (r.x + fx * r.width) / w, sy: (r.y + fy * r.height) / h }
}
