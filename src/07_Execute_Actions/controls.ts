// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one mapping from a player's merged intent (head yaw, the analog frame,
 * held keys) to what the physics realm accepts: on foot a desired walking velocity in the world and the way
 * the body faces, at the wheel steer, throttle, brake and the handbrake. It is the frame loop's control
 * block as a pure function, so the engine can run it once per seat and a table of intents proves the numbers
 * in Node: keyboard diagonals are normalised, a half-pushed stick walks at half speed, Shift or the run latch
 * runs, left stick Y drives as well as the triggers, and nothing non-finite ever reaches the realm.
 * What breaks if it is removed? The frame loop has no controls to send: nobody walks or drives.
 */
import type { Analog } from '../04_Connect_Hardware/gamepad.ts'
import { RUN, WALK, type DriveControls, type FootControls } from './simProtocol.ts'

/** The keys the mapping reads (KeyboardEvent.code). The README's Controls table names each. */
export const CONTROL_KEYS = Object.freeze({
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  run: 'ShiftLeft',
  handbrake: 'Space',
} as const)

/**
 * Second keys for the same moves: the arrows (any layout, and a left hand on the mouse) and the right Shift. The
 * letters stay where QWERTY puts them on every layout (KeyboardEvent.code is the key's place, not its label).
 */
export const CONTROL_ALT_KEYS = Object.freeze({
  forward: 'ArrowUp',
  back: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  run: 'ShiftRight',
} as const)

/** What the mapping reads of a player's intent (Input and every PadSeat satisfy it as they are). */
export interface ControlSource {
  readonly yaw: number
  readonly analog: Readonly<Analog>
  down(code: string): boolean
}

/** An angle wrapped into [−π, π], the way the realm folds it (atan2 of its sine and cosine). */
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a))
/** A broken axis (NaN, ±Infinity) reads as centred. */
const num = (v: number): number => (Number.isFinite(v) ? v : 0)
/** A move held on its own key or its second key. */
const held = (intent: ControlSource, move: keyof typeof CONTROL_ALT_KEYS): boolean =>
  intent.down(CONTROL_KEYS[move]) || intent.down(CONTROL_ALT_KEYS[move])

/**
 * Fills both control sets from one intent, every field written: the realm applies the set that matches its own
 * state (on foot or at the wheel) and the other is at rest. `driving` picks which set carries the intent.
 * Allocation-free, and every output is finite whatever the inputs.
 *
 * On foot: W/S (or the up and down arrows) along the head's forward (−sin yaw, −cos yaw), D/A along its right (cos yaw, −sin yaw), plus the
 * stick's (moveX, moveY) on the same basis; the sum is normalised when it exceeds unit length (keyboard
 * diagonals) and otherwise scaled as it is (a half-pushed stick walks at half speed), at RUN with Shift or the
 * run latch (either Shift), WALK otherwise. `heading` is the way the body faces: the view's yaw turned about, wrapped to [−π, π].
 * At the wheel: steer = A − D + stick steer, clamped to ±1; fwd = 1 with W, else the larger of the throttle and
 * the forward stick; back = 1 with S, else the larger of the brake and the backward stick; handbrake = Space or
 * the pad's handbrake.
 */
export function readControls(intent: ControlSource, driving: boolean, foot: FootControls, drive: DriveControls): void {
  const a = intent.analog
  const yaw = num(intent.yaw)
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
  const rx = Math.cos(yaw), rz = -Math.sin(yaw)
  foot.x = 0
  foot.z = 0
  // The player's own body faces where the head looks; it only turns that figure in the realm's crowd.
  foot.heading = wrap(yaw + Math.PI)
  drive.steer = 0
  drive.fwd = 0
  drive.back = 0
  drive.handbrake = false
  const moveX = num(a.moveX), moveY = num(a.moveY)
  if (!driving) {
    let mx = 0, mz = 0
    if (held(intent, 'forward')) { mx += fx; mz += fz }
    if (held(intent, 'back')) { mx -= fx; mz -= fz }
    if (held(intent, 'right')) { mx += rx; mz += rz }
    if (held(intent, 'left')) { mx -= rx; mz -= rz }
    mx += fx * moveY + rx * moveX
    mz += fz * moveY + rz * moveX
    // Keyboard diagonals are normalised; a half-pushed stick walks at half speed.
    const len = Math.hypot(mx, mz)
    const speed = held(intent, 'run') || a.run === true ? RUN : WALK
    const k = len > 1 ? speed / len : speed
    foot.x = mx * k
    foot.z = mz * k
  } else {
    const steer = (held(intent, 'left') ? 1 : 0) - (held(intent, 'right') ? 1 : 0) + num(a.steer)
    drive.steer = steer > 1 ? 1 : steer < -1 ? -1 : steer
    // Left stick Y drives as well as the triggers (touch already folds its stick into throttle/brake; max() keeps one source).
    drive.fwd = held(intent, 'forward') ? 1 : Math.max(num(a.throttle), moveY > 0 ? moveY : 0)
    drive.back = held(intent, 'back') ? 1 : Math.max(num(a.brake), moveY < 0 ? -moveY : 0)
    drive.handbrake = intent.down(CONTROL_KEYS.handbrake) || a.handbrake === true
  }
}
