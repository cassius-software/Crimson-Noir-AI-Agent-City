// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the headset's input driver: an XR session's input sources (immersive-web.github.io/
 * webxr) read into the same Analog frame and action edges the pads produce (gamepad.ts), so walking, turning, driving,
 * pinging and entering a car work with whatever a headset holds. It is pure (no DOM, no three), so every mapping is
 * unit-tested in Node against fake sources.
 * Every source is read by its shape, never by its name, so no maker's product is named here and a headset nobody has
 * listed still works. A controller is a tracked pointer (not a hand) whose gamepad carries the `xr-standard` mapping
 * (the WebXR Gamepads Module) and at least one pair of axes: buttons 0 trigger, 1 squeeze, 2 touchpad press, 3
 * thumbstick press, then up to two face buttons at 4 and 5; axes 0/1 the touchpad (the finger's place, 0 when not
 * touched), 2/3 the thumbstick, +x right, +y down (as a pad's). That covers the thumbstick pairs, the pairs with a
 * thumbstick and a touchpad, the touchpad wands, and the single pointing controllers with a touchpad. Everything else
 * (a hand with only its pinch, a gaze-and-pinch headset's transient pointer, a phone's screen in handheld AR, a gaze
 * button, a stylus or a controller with no axes) is a pointer: read by the session's select events (xrSession.ts),
 * where a pinch held and moved walks (PinchDrag below) and a quick one is a tap (the interaction at hand, else a ping).
 * With two controllers the left walks and the right turns and drives:
 *   left:  thumbstick, or the touchpad while touched, walks (head-relative on foot) and steers; squeeze = handbrake;
 *          the stick's or the touchpad's click latches a run; the trigger pings; the upper face button resets a car.
 *   right: thumbstick snap-turns on foot (the touchpad snaps on a click to either side); trigger = throttle; squeeze =
 *          brake; the lower face button pings, the upper one enters or leaves a car (without one, a touchpad click,
 *          and the trigger on foot does what is at hand); the stick's click is the microphone's mute.
 * A controller alone, of whatever hand, does both: its stick or touchpad walks forward and back and snap-turns by
 * sectors on foot (never both at once), and at the wheel steers and drives; its trigger is the throttle at the wheel and
 * on foot does what is at hand; its squeeze brakes; its stick's click latches a run on foot and is the handbrake at the
 * wheel; a touchpad's centre click does what is at hand and an edge click snap-turns. At the wheel, holding the walking
 * hand's stick or touchpad click for a second with the car stopped steps out, for any controller; a touchpad click or a
 * pinch that would step out of a moving car is refused (`refused`) and the engine says why.
 * Walking is head-relative on foot: the stick's forward is where the headset looks (headOffset), while the body turns
 * only in snaps, so the view never swings under a thumb. A pinch's drag is already in the body's frame.
 * UNCONFIRMED on a physical headset: the layouts are the registry's and the module's, read here from fakes.
 * What breaks if it is removed? A headset's controllers move nothing; the hands pinch at a city that cannot hear.
 */

import { createAnalog, PAD_EDGE, radialDeadzone, triggerValue, zeroAnalog, type Analog } from './gamepad.ts'
import type { XrInputSourceLike } from './web-hardware.d.ts'

/** The xr-standard mapping's button indices (4 and 5 are device-specific face buttons, in decreasing importance). */
export const XR_BUTTON = { trigger: 0, squeeze: 1, touchpad: 2, thumbstick: 3, primary: 4, secondary: 5 } as const
/** The xr-standard mapping's axes. */
export const XR_AXIS = { touchpadX: 0, touchpadY: 1, thumbX: 2, thumbY: 3 } as const

/** Snap turning: a flick past `on` turns the body by `step`; the stick must come back under `off` before the next. */
export const XR_TURN = Object.freeze({ step: Math.PI / 6, on: 0.6, off: 0.3 })
/** The stick's radial dead zone (a tracked controller's thumbstick rests less true than a pad's). */
export const XR_DEADZONE = 0.15
/** A touchpad's: its axes are the finger's place, not a spring's, and a resting thumb lies anywhere on it. */
export const XR_PAD_DEADZONE = 0.3
/** A touchpad clicked further than this from its centre, sideways, snap-turns on foot instead of acting. */
export const XR_PAD_EDGE = 0.5
/** A thumb this far out on a touchpad that walks runs. */
export const XR_PAD_RUN = 0.9
/** A controller alone splits its stick by sectors: a snap within `snap` of sideways, a walk within `walk` of forward or back. */
export const XR_SECTOR = Object.freeze({ snap: (35 * Math.PI) / 180, walk: (55 * Math.PI) / 180 })
/** At the wheel, the walking hand's click held this long with the car stopped steps out. */
export const XR_HOLD_OUT_MS = 1000
/** A car slower than this, m/s, has stopped enough to step out of from a tap or a touchpad click (engine.ts). */
export const XR_STEP_OUT_SPEED = 1.5

/** Which duties a controller takes: the walking hand's, the turning and driving hand's, or both (a controller alone). */
export type XrRole = 'left' | 'right' | 'both'

/** By handedness, as a pair would split them: a controller of no hand takes both. */
export function roleOf(s: Pick<XrInputSourceLike, 'handedness'>): XrRole {
  return s.handedness === 'left' ? 'left' : s.handedness === 'right' ? 'right' : 'both'
}

/**
 * A source the mapper reads by its gamepad: a tracked pointer that is not a hand, with the xr-standard mapping and a
 * touchpad or a thumbstick. A hand's gamepad (its pinch, a grasp, gestures at 4 and up) and an axes-less controller's
 * (a stylus's tip force at 5) never are: their buttons 4 and 5 are not face buttons. Never tested by `gamepad !== null`:
 * some browsers give every source a gamepad, with mapping ''.
 */
export function isController(s: XrInputSourceLike): boolean {
  const g = s.gamepad
  return s.targetRayMode === 'tracked-pointer' && !s.hand && !!g && g.mapping === 'xr-standard' && g.axes.length >= 2 && g.buttons.length >= 1
}

/** A source read by its select events: a pinch, a hand, a phone's screen, a gaze button, a controller with no axes. */
export function isPointerOnly(s: XrInputSourceLike): boolean {
  return !isController(s)
}

/** How a pointer's pinch is read: dragged by its grip (the hand), by its ray (a tracked pointer with no grip), or only tapped. */
export type PinchKind = 'grip' | 'ray' | 'tap'

/**
 * A gaze source's ray is the head and a phone screen's follows the finger across the glass: both only tap. A transient
 * pointer drags only by its grip (the pinching fingers): its ray starts between the eyes and swings with the wrist.
 */
export function pinchKindOf(s: XrInputSourceLike & { readonly gripSpace?: unknown }): PinchKind {
  const grip = s.gripSpace !== undefined && s.gripSpace !== null
  if (s.targetRayMode === 'transient-pointer') return grip ? 'grip' : 'tap'
  if (s.targetRayMode === 'tracked-pointer') return grip ? 'grip' : 'ray'
  return 'tap'
}

/** What a controller's gamepad has: a thumbstick, a touchpad that walks (no thumbstick), a touchpad press, face buttons. */
export interface XrShape { readonly stick: boolean; readonly padWalks: boolean; readonly pad: boolean; readonly faces: 0 | 1 | 2 }

export function shapeOf(s: XrInputSourceLike): XrShape {
  const g = s.gamepad
  const axes = g?.axes.length ?? 0, buttons = g?.buttons.length ?? 0
  const stick = axes > XR_AXIS.thumbY
  return { stick, padWalks: !stick && axes > XR_AXIS.touchpadY, pad: buttons > XR_BUTTON.touchpad, faces: buttons > XR_BUTTON.secondary ? 2 : buttons > XR_BUTTON.primary ? 1 : 0 }
}

const pressed = (s: XrInputSourceLike, i: number): boolean => {
  const b = s.gamepad?.buttons[i]
  return !!b && (b.pressed || b.value > 0.5)
}
/** A touchpad is read while touched (or pressed); a browser that reports no `touched` is trusted to zero it untouched. */
const padTouched = (s: XrInputSourceLike): boolean => {
  const b = s.gamepad?.buttons[XR_BUTTON.touchpad] as { touched?: boolean; pressed: boolean; value: number } | undefined
  if (!b) return true
  return b.touched === undefined ? true : b.touched || b.pressed
}
const axis = (s: XrInputSourceLike, i: number): number => {
  const v = s.gamepad?.axes[i]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Pinch-and-drag walking, in metres and milliseconds. */
export const PINCH = Object.freeze({
  /** A pinch let go within this time, having moved less than tapM, is a tap. */
  tapMs: 400,
  tapM: 0.025,
  /** Moved this far, the pinch drags, and can never be a tap again. */
  engageM: 0.03,
  /** The drag's dead zone, and where it reaches full speed (a hand's tremor and its arc stay inside the first). */
  deadM: 0.03,
  fullM: 0.13,
  /** Drawn this far, it runs. */
  runM: 0.21,
  /** A drag mostly sideways past turnM snap-turns once, again only after it has come back inside turnOffM. */
  turnM: 0.08,
  turnOffM: 0.04,
  /** On foot it walks within this angle of forward or back; the rest of the circle is the turn's. */
  walkSector: (50 * Math.PI) / 180,
  /** The drag's direction is smoothed with this time constant. */
  smoothMs: 100,
  /** A pinch whose pose was lost this recently is no tap (it may be a hand leaving view). */
  lostMs: 250,
})

/** A position in the session's reference space, metres. */
export interface XrPoint { readonly x: number; readonly y: number; readonly z: number }

interface Pinch {
  readonly kind: PinchKind
  readonly transient: boolean
  readonly t0: number
  /** The hand where the pinch began (raw), for the tap's test; null until a pose is seen. */
  start: XrPoint | null
  /** The hand less the head where the drag began, for the drag; null until a frame with both. */
  ax: number | null
  az: number | null
  /** The furthest the hand has been from where it began, metres. */
  peak: number
  engaged: boolean
  lostAt: number
}

/**
 * The pinches held at the moment, by source: the first to drag is the one that walks (a second pinch can still tap).
 * Fed numbers by the session (xrSession.ts): where each began (`start`), every frame's hand and head (`sample`), and
 * where it was let go (`end`, which says whether it was a tap); `cancel` for one that ended without a select, left the
 * session, or was cut off by a recentre or the session's menu. Pure: no WebXR objects but the sources as keys.
 */
export class PinchDrag {
  private readonly held = new Map<object, Pinch>()
  /** Pinches dropped by `clear` (a recentre, the session's menu): their own select is never a tap. */
  private readonly dropped = new WeakSet<object>()
  private walker: object | null = null
  /** The walker's displacement from where its drag began, in the body's frame (metres, +x right, +z back). */
  dx = 0
  dz = 0
  /** The smoothed unit direction of the drag and its stepped speed (0, 0.5 or 1). */
  private ux = 0
  private uz = 0
  level = 0
  private lastT = -1
  /** Snap steps the drag has asked for and the mapper has not yet taken (rad, + to the right). */
  turn = 0
  private turnArmed = true

  /** A drag is walking. */
  get dragging(): boolean {
    return this.walker !== null && this.level > 0
  }

  /** How many pinches are held. */
  get size(): number {
    return this.held.size
  }

  start(id: object, kind: PinchKind, transient: boolean, t: number, hand: XrPoint | null): void {
    this.dropped.delete(id)
    this.held.set(id, { kind, transient, t0: t, start: hand, ax: null, az: null, peak: 0, engaged: false, lostAt: hand === null ? t : -Infinity })
  }

  /** One headset frame: where the pinching hand and the head are (null where the hand is not tracked). */
  sample(id: object, t: number, hand: XrPoint | null, head: XrPoint | null): void {
    const p = this.held.get(id)
    if (!p) return
    if (hand === null) {
      p.lostAt = t
      if (this.walker === id) this.still(t)
      return
    }
    if (p.start === null) p.start = hand
    else p.peak = Math.max(p.peak, Math.hypot(hand.x - p.start.x, hand.y - p.start.y, hand.z - p.start.z))
    if (p.kind === 'tap' || head === null) return
    // The hand less the head, so a lean or a step does not walk: only the hand moving against the head does.
    const rx = hand.x - head.x, rz = hand.z - head.z
    if (p.ax === null || p.az === null) { p.ax = rx; p.az = rz; return }
    const dx = rx - p.ax, dz = rz - p.az
    if (!p.engaged && Math.hypot(dx, dz) > PINCH.engageM && (this.walker === null || this.walker === id)) {
      p.engaged = true
      this.walker = id
    }
    if (this.walker !== id) return
    this.dx = dx
    this.dz = dz
    this.step(t)
  }

  /** The pinch was let go (its select): 'tap' when it was one, else 'none'. Forgets it. */
  end(id: object, t: number, hand: XrPoint | null): 'tap' | 'none' {
    if (this.dropped.has(id)) { this.dropped.delete(id); return 'none' }
    const p = this.held.get(id)
    this.forget(id)
    // A select with no pinch seen to begin (a source the session gave no selectstart for) keeps the old behaviour.
    if (!p) return 'tap'
    if (p.kind === 'tap') return 'tap'
    // The release itself moves a transient pointer's grip (the fingers part): its last sample is not counted.
    if (hand === null) p.lostAt = t
    else if (!p.transient && p.start !== null) p.peak = Math.max(p.peak, Math.hypot(hand.x - p.start.x, hand.y - p.start.y, hand.z - p.start.z))
    if (p.engaged || t - p.t0 > PINCH.tapMs || p.peak >= PINCH.tapM) return 'none'
    // A hand's pose lost a moment ago may be the hand leaving view (tracking can see a false pinch as it goes). A
    // transient pointer is the system's own pinch and lives only while held, so its tap never waits on a pose.
    if (!p.transient && t - p.lostAt < PINCH.lostMs) return 'none'
    return 'tap'
  }

  /** The pinch ended without a select (cancelled), or its source left: forgotten, no tap. */
  cancel(id: object): void {
    this.dropped.delete(id)
    this.forget(id)
  }

  /** Every pinch dropped (a recentre, the session's menu over the city): none of them taps when it is let go. */
  clear(): void {
    for (const id of this.held.keys()) this.dropped.add(id)
    this.held.clear()
    this.walker = null
    this.halt()
  }

  /** The ids held, for the session to drop those whose source has left. */
  ids(): IterableIterator<object> {
    return this.held.keys()
  }

  private forget(id: object): void {
    this.held.delete(id)
    if (this.walker === id) { this.walker = null; this.halt() }
  }

  private halt(): void {
    this.dx = 0; this.dz = 0; this.ux = 0; this.uz = 0; this.level = 0; this.lastT = -1; this.turnArmed = true
  }

  /** A frame with no pose for the walker: it stands still (never the last vector, which could walk on blind). */
  private still(t: number): void {
    this.level = 0
    this.lastT = t
  }

  private step(t: number): void {
    const d = Math.hypot(this.dx, this.dz)
    // The speed in steps, with hysteresis, so a hand's small wobble never changes it continuously.
    const r = Math.min(1, Math.max(0, (d - PINCH.deadM) / (PINCH.fullM - PINCH.deadM)))
    // A quick reach can cross both steps in one frame (no frame of half speed first), and a quick return both back.
    if (this.level === 0 && r >= 0.3) this.level = 0.5
    if (this.level === 0.5 && r >= 0.85) this.level = 1
    else if (this.level === 0.5 && r < 0.15) this.level = 0
    else if (this.level === 1 && r < 0.65) this.level = r < 0.15 ? 0 : 0.5
    // The direction, smoothed over about a tenth of a second.
    if (d > 1e-6) {
      const nx = this.dx / d, nz = this.dz / d
      const k = this.lastT < 0 || this.level === 0 ? 1 : 1 - Math.exp(-Math.max(0, t - this.lastT) / PINCH.smoothMs)
      this.ux += (nx - this.ux) * k
      this.uz += (nz - this.uz) * k
      const m = Math.hypot(this.ux, this.uz)
      if (m > 1e-6) { this.ux /= m; this.uz /= m }
    }
    this.lastT = t
  }

  /**
   * Writes the drag into `out` (zeroed by the caller) and takes any snap it earned: on foot a walk within the walk sector
   * and a snap for a sideways drag, a run past runM; at the wheel x steers and z drives. False when it gives nothing.
   */
  read(out: Analog, driving: boolean): boolean {
    if (this.walker === null) return false
    const dx = this.dx, dz = this.dz
    if (driving) {
      const steer = Math.max(-1, Math.min(1, dx / PINCH.fullM))
      const fwd = Math.max(-1, Math.min(1, -dz / PINCH.fullM))
      const live = Math.hypot(dx, dz) > PINCH.deadM
      out.steer = live ? -steer || 0 : 0
      out.moveX = live ? steer : 0
      out.moveY = live ? fwd : 0
      return live
    }
    // Sideways past the turn's reach: one snap, re-armed once the hand comes back near the middle.
    const side = Math.abs(dx)
    if (this.turnArmed && side > PINCH.turnM && side > 2 * Math.abs(dz)) { this.turn += dx > 0 ? XR_TURN.step : -XR_TURN.step; this.turnArmed = false }
    else if (!this.turnArmed && side < PINCH.turnOffM) this.turnArmed = true
    const ang = Math.atan2(Math.abs(this.ux), Math.abs(this.uz))
    if (this.level === 0 || ang > PINCH.walkSector) return false
    out.moveX = this.ux * this.level
    out.moveY = -this.uz * this.level || 0
    out.run = Math.hypot(dx, dz) > PINCH.runM
    return true
  }

  /** Taken by the mapper once per read. */
  takeTurn(): number {
    const t = this.turn
    this.turn = 0
    return t
  }
}

/**
 * Reads the session's live input sources once per frame into an Analog and the frame's action edges. The head
 * offset (the posed head's yaw minus the body's) turns the stick into the head's frame on foot, so forward is where
 * the headset looks; `turn` is the body yaw to subtract this frame (snap turns), cleared by the reader. The engine sets
 * the context (`driving`, `nearCar`, `stopped`) before each poll, so "what is at hand" can be resolved here.
 */
export class XrMapper {
  /** The session's live source list; null outside a session. */
  sources: ArrayLike<XrInputSourceLike> | null = null
  readonly analog: Analog = createAnalog()
  /** The pinches held by the session's pointers (fed by xrSession.ts). */
  readonly pinches = new PinchDrag()
  /** Body yaw to subtract this frame, rad (a snap to the right is positive, as a pad's look is). */
  turn = 0
  /** The head's yaw minus the body's, rad: the engine sets it from the posed head before each poll (0 at the wheel). */
  headOffset = 0
  /** At the wheel this frame (the engine's word). */
  driving = false
  /** On foot beside a parked car this frame: what is at hand is its door. */
  nearCar = false
  /** The car is slow enough to step out of (always true on foot). */
  stopped = true
  /** A controller has moved or pressed since the session began. */
  used = false
  /** A controller moved or pressed this frame. */
  active = false
  /** The run latch (the walking hand's stick or touchpad click toggles it). */
  private run = false
  private readonly bits = new WeakMap<object, number>()
  private readonly heldSince = new WeakMap<object, number>()
  private readonly stick = { x: 0, y: 0 }
  private readonly pinchOut: Analog = createAnalog()
  private readonly headVec = { moveX: 0, moveY: 0 }
  private armed = true
  private padArmed = true
  private refusedFlag = false
  private readonly now: () => number

  constructor(now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
    this.now = now
  }

  /**
   * A move in the body's frame turned into the head's, on foot (at the wheel, or with the head the body's way, as it
   * was): the sticks' forward is where the headset looks. A pad held inside a headset is turned by it too (input.ts).
   */
  toHead(a: { moveX: number; moveY: number }): void {
    const o = this.driving ? 0 : this.headOffset
    if (o === 0 || !Number.isFinite(o) || (a.moveX === 0 && a.moveY === 0)) return
    const c = Math.cos(o), sn = Math.sin(o)
    const x = a.moveX * c - a.moveY * sn, y = a.moveY * c + a.moveX * sn
    a.moveX = x; a.moveY = y
  }

  /** True while a session has handed over its sources. */
  get live(): boolean {
    return this.sources !== null
  }

  /** A step out of a moving car was refused since this was last asked (the engine says why). */
  takeRefused(): boolean {
    const r = this.refusedFlag
    this.refusedFlag = false
    return r
  }

  /** What is at hand: the car's door (in or out, out only once it has stopped), else a ping where the head looks. */
  use(): number {
    if (this.driving) {
      if (this.stopped) return PAD_EDGE.interact
      this.refusedFlag = true
      return 0
    }
    return this.nearCar ? PAD_EDGE.interact : PAD_EDGE.ping
  }

  /**
   * One frame: the Analog and the PAD_EDGE bits of the rising presses. Roles come from the whole list every frame: a
   * controller alone does both hands' duties, whatever hand it says it is; two split them by hand (two of one hand,
   * or of none, split by order). Nothing without sources.
   */
  read(out: Analog = this.analog): number {
    const list = this.sources
    zeroAnalog(out)
    this.active = false
    if (!list) { this.turn = 0; out.run = this.run; return 0 }
    let edges = 0
    let mx = 0, my = 0, steer = 0, turn = 0, latchable = 0
    const roles = this.rolesOf(list)
    const now = this.now()
    for (let i = 0; i < list.length; i++) {
      const s = list[i]
      const role = roles[i]
      if (role === null) continue
      const g = s.gamepad!
      const shape = shapeOf(s)
      if (shape.stick || shape.padWalks) latchable++
      // Edges: a source first seen only teaches what it holds (a button held as it woke, or came back, is no press).
      const known = this.bits.has(s)
      const prev = this.bits.get(s) ?? 0
      let bits = 0
      for (let b = 0; b <= XR_BUTTON.secondary; b++) if (pressed(s, b)) bits |= 1 << b
      this.bits.set(s, bits)
      const rising = known ? bits & ~prev : 0
      const press = (b: number) => (rising & (1 << b)) !== 0
      const holding = (b: number) => (bits & (1 << b)) !== 0
      // The walking surface: the thumbstick, else the touchpad while touched (and not clicked, on a pad that also acts).
      const d = this.stick
      let sx = 0, sy = 0, rim = false
      if (shape.stick) {
        radialDeadzone(axis(s, XR_AXIS.thumbX), axis(s, XR_AXIS.thumbY), XR_DEADZONE, d)
        sx = d.x; sy = d.y
      } else if (shape.padWalks && padTouched(s) && !(role === 'both' && holding(XR_BUTTON.touchpad))) {
        const px = axis(s, XR_AXIS.touchpadX), py = axis(s, XR_AXIS.touchpadY)
        radialDeadzone(px, py, XR_PAD_DEADZONE, d)
        sx = d.x; sy = d.y
        rim = Math.hypot(px, py) > XR_PAD_RUN
      }
      const padX = axis(s, XR_AXIS.touchpadX)
      // The walking hand's click (the stick's, else the touchpad's on a pad that walks): the run latch on foot; at the
      // wheel, held for XR_HOLD_OUT_MS with the car stopped, it steps out.
      const clickBtn = shape.stick ? XR_BUTTON.thumbstick : shape.padWalks ? XR_BUTTON.touchpad : -1
      if (role !== 'right' && clickBtn >= 0) {
        if (holding(clickBtn) && this.driving) {
          const since = this.heldSince.get(s)
          if (since === undefined) this.heldSince.set(s, press(clickBtn) ? now : Infinity)
          else if (Number.isFinite(since) && now - since >= XR_HOLD_OUT_MS && this.stopped) { edges |= PAD_EDGE.interact; this.heldSince.set(s, Infinity) }
        } else this.heldSince.delete(s)
      }
      if (role === 'both') {
        // Alone: forward and back walk, sideways snaps (by sectors, never both); at the wheel it steers and drives.
        if (this.driving) {
          steer = -sx || 0; mx = sx; my = -sy || 0
          if (shape.stick && holding(XR_BUTTON.thumbstick)) out.handbrake = true
        } else {
          const m = Math.hypot(sx, sy)
          if (m > 0) {
            const fromSide = Math.atan2(Math.abs(sy), Math.abs(sx))
            if (fromSide <= XR_SECTOR.snap) turn = sx
            else if (Math.PI / 2 - fromSide <= XR_SECTOR.walk) my = -sy || 0
          }
          if (shape.padWalks && rim) out.run = true
          if (clickBtn === XR_BUTTON.thumbstick && press(XR_BUTTON.thumbstick)) this.run = !this.run
        }
        out.throttle = Math.max(out.throttle, triggerValue(g.buttons[XR_BUTTON.trigger]))
        out.brake = Math.max(out.brake, triggerValue(g.buttons[XR_BUTTON.squeeze]))
        if (!this.driving && press(XR_BUTTON.trigger)) edges |= this.use()
        if (shape.faces >= 1 && press(XR_BUTTON.primary)) edges |= PAD_EDGE.ping
        if (shape.faces >= 2 && press(XR_BUTTON.secondary)) edges |= PAD_EDGE.interact
        if (shape.padWalks && press(XR_BUTTON.touchpad)) {
          // A centre click is what is at hand; an edge click snap-turns on foot (at the wheel any click steps out).
          if (!this.driving && Math.abs(padX) > XR_PAD_EDGE) this.padSnapStep(padX)
          else edges |= this.use()
        }
      }
      if (role === 'left') {
        if (Math.hypot(sx, sy) > Math.hypot(mx, my)) { mx = sx; my = -sy || 0; steer = -sx || 0 }
        if (holding(XR_BUTTON.squeeze)) out.handbrake = true
        if (!this.driving && clickBtn >= 0 && press(clickBtn)) this.run = !this.run
        if (shape.padWalks && rim && !this.driving) out.run = true
        if (press(XR_BUTTON.trigger)) edges |= PAD_EDGE.ping
        if (this.driving && shape.faces >= 2 && press(XR_BUTTON.secondary)) edges |= PAD_EDGE.reset
      }
      if (role === 'right') {
        if (shape.stick) turn = axis(s, XR_AXIS.thumbX)
        out.throttle = Math.max(out.throttle, triggerValue(g.buttons[XR_BUTTON.trigger]))
        out.brake = Math.max(out.brake, triggerValue(g.buttons[XR_BUTTON.squeeze]))
        if (shape.faces >= 1 && press(XR_BUTTON.primary)) edges |= PAD_EDGE.ping
        if (shape.faces >= 2 && press(XR_BUTTON.secondary)) edges |= PAD_EDGE.interact
        if (shape.stick && press(XR_BUTTON.thumbstick)) edges |= PAD_EDGE.mute
        if (shape.faces < 2 && shape.pad && press(XR_BUTTON.touchpad)) {
          // No upper face button: the touchpad's click enters and leaves; a pad that turns snaps on an edge click on foot.
          if (shape.padWalks && !this.driving && Math.abs(padX) > XR_PAD_EDGE) this.padSnapStep(padX)
          else edges |= PAD_EDGE.interact
        } else if (shape.padWalks && press(XR_BUTTON.touchpad) && !this.driving && Math.abs(padX) > XR_PAD_EDGE) this.padSnapStep(padX)
        // No upper face button: the trigger on foot does what is at hand too (a stick controller's button 2 may be a
        // placeholder that never presses, and nothing tells it from a real touchpad's).
        if (shape.faces < 2 && !this.driving && press(XR_BUTTON.trigger)) edges |= this.use()
      }
      if (bits !== 0 || sx !== 0 || sy !== 0 || Math.abs(turn) > XR_DEADZONE) { this.used = true; this.active = true }
    }
    // No controller that can latch a run is left (put down for hands): the latch goes with it.
    if (latchable === 0) this.run = false
    out.run = out.run || this.run
    // On foot, the stick in the head's frame: forward is where the headset looks, not where the body stands.
    const v = this.headVec
    v.moveX = mx; v.moveY = my
    this.toHead(v)
    mx = v.moveX; my = v.moveY
    // A pinch's drag, already in the body's frame: the larger of it and the sticks moves.
    const p = this.pinchOut
    zeroAnalog(p)
    if (this.pinches.read(p, this.driving)) {
      if (p.moveX * p.moveX + p.moveY * p.moveY > mx * mx + my * my) { mx = p.moveX; my = p.moveY; steer = p.steer }
      if (p.run) out.run = true
      this.active = true
      this.used = true
    }
    out.moveX = mx
    out.moveY = my
    out.steer = steer
    // Snap turns, on foot only (at the wheel the body faces the car's way): one step per flick, re-armed once back.
    let step = 0
    if (!this.driving) {
      if (this.armed && Math.abs(turn) >= XR_TURN.on) { step = turn > 0 ? XR_TURN.step : -XR_TURN.step; this.armed = false }
      else if (!this.armed && Math.abs(turn) < XR_TURN.off) this.armed = true
    } else this.armed = true
    this.turn = step + this.pendingPad + this.pinches.takeTurn()
    this.pendingPad = 0
    return edges
  }

  private readonly roleList: (XrRole | null)[] = []
  /**
   * Each source's duties, null for a pointer: a controller alone takes both, whatever hand it says; with two or more
   * each takes its hand's, and when that leaves the walking or the turning hand without a controller (two of one hand,
   * or of none) the first takes the walking hand's and the second the other's.
   */
  private rolesOf(list: ArrayLike<XrInputSourceLike>): readonly (XrRole | null)[] {
    const r = this.roleList
    r.length = list.length
    let count = 0, left = false, right = false
    for (let i = 0; i < list.length; i++) {
      if (!isController(list[i])) { r[i] = null; continue }
      const role = roleOf(list[i])
      r[i] = role
      count++
      if (role === 'left') left = true
      if (role === 'right') right = true
    }
    if (count === 1) { for (let i = 0; i < r.length; i++) if (r[i] !== null) r[i] = 'both'; return r }
    if (count >= 2 && !(left && right)) {
      let n = 0
      for (let i = 0; i < r.length; i++) if (r[i] !== null) { r[i] = n === 0 ? 'left' : n === 1 ? 'right' : r[i]; n++ }
    }
    return r
  }

  private pendingPad = 0
  private padSnapStep(x: number): void {
    this.pendingPad += x > 0 ? XR_TURN.step : -XR_TURN.step
  }

  /**
   * A standard pad's right stick inside a headset: snap steps (the same thresholds), never a smooth turn, since a turn
   * the eyes do not make is what makes a headset sick. Returns the yaw to subtract this read (rad).
   */
  padSnap(lookX: number): number {
    if (this.padArmed && Math.abs(lookX) >= XR_TURN.on) { this.padArmed = false; return lookX > 0 ? XR_TURN.step : -XR_TURN.step }
    if (!this.padArmed && Math.abs(lookX) < XR_TURN.off) this.padArmed = true
    return 0
  }

  /** The session ended, or the page suspended input: everything idle, the run latch off, every pinch dropped. */
  reset(): void {
    zeroAnalog(this.analog)
    this.turn = 0
    this.run = false
    this.armed = true
    this.padArmed = true
    this.pendingPad = 0
    this.active = false
    this.refusedFlag = false
    this.pinches.clear()
  }
}
