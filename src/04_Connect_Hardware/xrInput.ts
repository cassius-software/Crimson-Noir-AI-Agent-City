// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the headset's input driver: an XR session's input sources (immersive-web.github.io/
 * webxr) read into the same Analog frame and action edges the pads produce (gamepad.ts), so walking, driving, pinging
 * and entering a car work from a tracked controller in each hand, or from a gaze-and-pinch headset with no
 * controller at all. It is pure (no DOM, no three), so every mapping is unit-tested in Node against fake sources.
 * A tracked controller's gamepad carries the `xr-standard` mapping (the WebXR Gamepads Module): buttons 0 trigger,
 * 1 squeeze, 2 touchpad press, 3 thumbstick press, then the two face buttons at 4 and 5 (A/X, B/Y in the input
 * profiles registry); axes 0/1 the touchpad, 2/3 the thumbstick, +x right, +y down (as a pad's). The left hand walks
 * and drives (thumbstick; squeeze = handbrake; thumbstick press = run latch), the right hand turns the body in snaps
 * (thumbstick x), accelerates (trigger), brakes (squeeze), pings (A, button 4) and enters or leaves a car (B, button
 * 5); a controller of no hand does the left hand's and the right hand's buttons at once. Walking is head-relative:
 * the stick's forward is where the headset looks (headOffset, set by the engine from the posed head), while the body
 * (Input.yaw) turns only in snaps, so the view never swings under a thumb. A source without a usable gamepad (Apple's
 * transient-pointer, a hand) is read by its session events (select = a pinch), which the session (07_Execute_Actions/
 * xrSession.ts) turns into an edge through the engine. Never through PadMapper: that reads axes 2/3 as a look and
 * buttons 0/1 as the south and east face buttons, which a tracked controller's are not.
 * UNCONFIRMED on a physical headset: the layouts are the registry's and the module's, read here from a fake.
 * What breaks if it is removed? A headset's controllers move nothing; the hands pinch at a city that cannot hear.
 */

import { createAnalog, PAD_EDGE, radialDeadzone, triggerValue, zeroAnalog, type Analog } from './gamepad.ts'
import type { XrInputSourceLike } from './web-hardware.d.ts'

/** The xr-standard mapping's button indices (buttons 4 and 5 are the registry's for the Touch-style controllers). */
export const XR_BUTTON = { trigger: 0, squeeze: 1, touchpad: 2, thumbstick: 3, primary: 4, secondary: 5 } as const
/** The xr-standard mapping's axes. */
export const XR_AXIS = { touchpadX: 0, touchpadY: 1, thumbX: 2, thumbY: 3 } as const

/** Snap turning: a flick past `on` turns the body by `step`; the stick must come back under `off` before the next. */
export const XR_TURN = Object.freeze({ step: Math.PI / 6, on: 0.6, off: 0.3 })
/** The stick's radial dead zone (a tracked controller's thumbstick rests less true than a pad's). */
export const XR_DEADZONE = 0.15

/** Which of the two hands' duties a source takes; a source of no hand takes both. */
export type XrRole = 'left' | 'right' | 'both'

export function roleOf(s: Pick<XrInputSourceLike, 'handedness'>): XrRole {
  return s.handedness === 'left' ? 'left' : s.handedness === 'right' ? 'right' : 'both'
}

/** A source the mapper reads by its gamepad: a tracked controller with the xr-standard mapping and a thumbstick. */
export function isTrackedController(s: XrInputSourceLike): boolean {
  const g = s.gamepad
  return !!g && g.mapping === 'xr-standard' && g.axes.length > XR_AXIS.thumbY && g.buttons.length > XR_BUTTON.squeeze
}

/** A source without a usable gamepad, read by its select events: a pinch on a gaze-and-pinch headset, or a hand. */
export function isPointerOnly(s: XrInputSourceLike): boolean {
  return !isTrackedController(s)
}

const pressed = (s: XrInputSourceLike, i: number): boolean => {
  const b = s.gamepad?.buttons[i]
  return !!b && (b.pressed || b.value > 0.5)
}
const axis = (s: XrInputSourceLike, i: number): number => {
  const v = s.gamepad?.axes[i]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Reads the session's live input sources once per frame into an Analog and the frame's action edges. The head
 * offset (the posed head's yaw minus the body's) turns the stick into the head's frame, so forward is where the
 * headset looks; `turn` is the body yaw to subtract this frame (snap turns), cleared by the reader.
 */
export class XrMapper {
  /** The session's live source list; null outside a session. */
  sources: ArrayLike<XrInputSourceLike> | null = null
  readonly analog: Analog = createAnalog()
  /** Body yaw to subtract this frame, rad (a snap to the right is positive, as a pad's look is). */
  turn = 0
  /** The head's yaw minus the body's, rad: the engine sets it from the posed head before each poll. */
  headOffset = 0
  /** A controller has moved or pressed since the session began. */
  used = false
  /** A controller moved or pressed this frame. */
  active = false
  /** The run latch (the left thumbstick press toggles it). */
  private run = false
  private readonly bits = new WeakMap<object, number>()
  private readonly stick = { x: 0, y: 0 }
  private armed = true

  /** True while a session has handed over its sources. */
  get live(): boolean {
    return this.sources !== null
  }

  /**
   * One frame: the Analog and the PAD_EDGE bits of the rising presses (ping from the right A, interact from the
   * right B; a controller of no hand gives both). Nothing without sources.
   */
  read(out: Analog = this.analog): number {
    const list = this.sources
    zeroAnalog(out)
    out.run = this.run
    this.active = false
    if (!list) { this.turn = 0; return 0 }
    let edges = 0
    let mx = 0, my = 0, steer = 0, turnX = 0
    for (let i = 0; i < list.length; i++) {
      const s = list[i]
      if (!isTrackedController(s)) continue
      const role = roleOf(s)
      const prev = this.bits.get(s) ?? 0
      let bits = 0
      for (let b = 0; b <= XR_BUTTON.secondary; b++) if (pressed(s, b)) bits |= 1 << b
      const rising = bits & ~prev
      this.bits.set(s, bits)
      if (role !== 'right') {
        const d = this.stick
        radialDeadzone(axis(s, XR_AXIS.thumbX), axis(s, XR_AXIS.thumbY), XR_DEADZONE, d)
        mx = d.x
        my = -d.y || 0 // never a negative zero for the still stick
        steer = -d.x || 0
        if (pressed(s, XR_BUTTON.squeeze)) out.handbrake = true
        if (rising & (1 << XR_BUTTON.thumbstick)) { this.run = !this.run; out.run = this.run }
      }
      if (role !== 'left') {
        turnX = axis(s, XR_AXIS.thumbX)
        out.throttle = Math.max(out.throttle, triggerValue(s.gamepad!.buttons[XR_BUTTON.trigger]))
        out.brake = Math.max(out.brake, triggerValue(s.gamepad!.buttons[XR_BUTTON.squeeze]))
        if (rising & (1 << XR_BUTTON.primary)) edges |= PAD_EDGE.ping
        if (rising & (1 << XR_BUTTON.secondary)) edges |= PAD_EDGE.interact
      }
      if (bits !== 0 || mx !== 0 || my !== 0 || Math.abs(turnX) > XR_DEADZONE) { this.used = true; this.active = true }
    }
    // The stick in the head's frame: forward is where the headset looks, not where the body stands.
    const o = this.headOffset
    if (o !== 0 && (mx !== 0 || my !== 0)) {
      const c = Math.cos(o), sn = Math.sin(o)
      const bx = mx * c - my * sn, by = my * c + mx * sn
      mx = bx; my = by
    }
    out.moveX = mx
    out.moveY = my
    out.steer = steer
    // Snap turns: one step per flick, re-armed once the stick comes back.
    let turn = 0
    if (this.armed && Math.abs(turnX) >= XR_TURN.on) { turn = turnX > 0 ? XR_TURN.step : -XR_TURN.step; this.armed = false }
    else if (!this.armed && Math.abs(turnX) < XR_TURN.off) this.armed = true
    this.turn = turn
    return edges
  }

  /** The session ended, or the page suspended input: everything idle, the run latch off. */
  reset(): void {
    zeroAnalog(this.analog)
    this.turn = 0
    this.run = false
    this.armed = true
    this.active = false
  }
}
