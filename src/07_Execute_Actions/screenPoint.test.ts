// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds screenPoint.ts to its word with three's own camera, set up as the city's is (the
 * WebGPU coordinate system, a reversed depth buffer, a 62-degree lens): a point ahead lands where it should, a point
 * straight behind is off screen rather than mirrored ahead, a point outside the lens is off screen, the same holds with
 * ordinary depth, and in split screen the point is placed inside its viewport.
 * What breaks if it is removed? A ping or the first walk's marker behind the visitor could be drawn ahead of them again
 * and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PerspectiveCamera, WebGPUCoordinateSystem } from 'three'
import { OFF_SCREEN, screenPoint } from './screenPoint.ts'

/** The city's camera at the origin, eye height 1.7 m, looking down −z (north), reversed depth as the renderer sets it. */
function cityCamera(reversed: boolean, aspect = 16 / 9): PerspectiveCamera {
  const cam = new PerspectiveCamera(62, aspect, 0.1, 2400)
  cam.coordinateSystem = WebGPUCoordinateSystem
  ;(cam as unknown as { _reversedDepth: boolean })._reversedDepth = reversed
  cam.position.set(0, 1.7, 0)
  cam.lookAt(0, 1.7, -1)
  cam.updateProjectionMatrix()
  cam.updateMatrixWorld(true)
  return cam
}

test('a point ahead lands on the screen; straight behind and outside the lens it is off screen, with reversed depth or not', () => {
  for (const reversed of [true, false]) {
    const cam = cityCamera(reversed)
    assert.equal(cam.reversedDepth, reversed)
    const ahead = screenPoint(cam, 2, 2.4, -10)
    assert.ok(ahead.sx > 0.5 && ahead.sx < 1, `ahead and to the right: ${ahead.sx}`)
    assert.ok(ahead.sy > 0 && ahead.sy < 0.5, `ahead and above the eye: ${ahead.sy}`)
    const centre = screenPoint(cam, 0, 1.7, -50)
    assert.ok(Math.abs(centre.sx - 0.5) < 1e-6 && Math.abs(centre.sy - 0.5) < 1e-6, 'straight ahead is the middle')
    // The mirror of the point ahead, behind the camera: the bug drew it at (1 − sx, 1 − sy) under reversed depth.
    assert.deepEqual(screenPoint(cam, 2, 2.4, 10), OFF_SCREEN, `behind is off screen (reversed ${reversed})`)
    assert.deepEqual(screenPoint(cam, 0, 1.7, 0), OFF_SCREEN, 'at the eye itself: off screen')
    assert.deepEqual(screenPoint(cam, 100, 1.7, -5), OFF_SCREEN, 'far to the side, outside the lens')
  }
})

test('in split screen a point is placed inside the camera\'s own viewport', () => {
  // Player 1 on the left half of a 1280 x 720 canvas: its camera takes that rect's aspect.
  const rect = { x: 0, y: 0, width: 640, height: 720 }
  const cam = cityCamera(true, rect.width / rect.height)
  const whole = screenPoint(cam, 0, 1.7, -50)
  const split = screenPoint(cam, 0, 1.7, -50, { rect, width: 1280, height: 720 })
  assert.ok(Math.abs(whole.sx - 0.5) < 1e-6)
  assert.ok(Math.abs(split.sx - 0.25) < 1e-6 && Math.abs(split.sy - 0.5) < 1e-6, 'the middle of the left half')
  // Player 2's rect on the right half: the same view lands in the middle of that half.
  const right = screenPoint(cam, 0, 1.7, -50, { rect: { x: 640, y: 0, width: 640, height: 720 }, width: 1280, height: 720 })
  assert.ok(Math.abs(right.sx - 0.75) < 1e-6)
  assert.deepEqual(screenPoint(cam, 0, 1.7, 50, { rect, width: 1280, height: 720 }), OFF_SCREEN, 'behind stays off screen')
})
