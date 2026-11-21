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
 *   right: thumbstick snap-turns on foot (a touchpad with no thumbstick snaps on a click to either side); trigger =
 *          throttle; squeeze = brake; the lower face button pings, the upper one is the car's door (without one, the
 *          touchpad's click is, and the trigger on foot does what is at hand); the stick's click is the microphone's mute.
 * A controller alone, of whatever hand, does both: its stick or touchpad walks forward and back, a stick snap-turns by
 * sectors on foot (never both at once) and a touchpad by an edge click; at the wheel it steers and drives. Its trigger
 * is the throttle at the wheel and on foot does what is at hand; its squeeze brakes; its stick's click latches a run on
 * foot, and at the wheel is the handbrake where it has an upper face button (its door) or, where it has none, the door
 * itself held for a second; a touchpad's centre click does what is at hand (one beside a stick, where there is no upper
 * face button, is the door; where there is one, nothing). The left hand's click held a second steps
 * out too. That second counts only while the car stays stopped, and every door (a button, a click, a pinch) is refused
 * while the car is faster than XR_STEP_OUT_SPEED: said (`takeRefused`, the engine's toast for the monitor) and buzzed
 * on the controller that asked, where its browser has an actuator. A trigger held into the wheel (the press that
 * opened the door, a resting finger, a worn trigger) gives no throttle where it is, only past where it eases back to.
 * Walking is head-relative on foot: the stick's forward is where the headset looks (headOffset), while the body turns
 * only in snaps, so the view never swings under a thumb. A pinch's drag moves the body the way the hand moved, measured
 * from the neck (a lean, a nod or a look around does not walk) and judged, walk or snap, against the way the head faced
 * when it began (a glance aside changes nothing). A blink of tracking stands it still; a longer loss spends it.
 * UNCONFIRMED on a physical headset: the layouts are the registry's and the module's, read here from fakes.
 * What breaks if it is removed? A headset's controllers move nothing; the hands pinch at a city that cannot hear.
 */

import { createAnalog, PAD_EDGE, PAD_TUNING, radialDeadzone, triggerValue, zeroAnalog, type Analog } from './gamepad.ts'
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
/** A touchpad with no thumbstick clicked further than this from its centre, sideways, snap-turns on foot instead of acting. */
export const XR_PAD_EDGE = 0.5
/** A thumb this far out on a touchpad that walks runs. */
export const XR_PAD_RUN = 0.9
/** A controller alone splits its stick by sectors: a snap within `snap` of sideways, a walk within `walk` of forward or back. */
export const XR_SECTOR = Object.freeze({ snap: (35 * Math.PI) / 180, walk: (55 * Math.PI) / 180 })
/** At the wheel, the walking hand's click held this long while the car stays stopped steps out (the second restarts while it rolls). */
export const XR_HOLD_OUT_MS = 1000
/** A car slower than this, m/s, has stopped enough to step out of, by any door (engine.ts tells the mapper). */
export const XR_STEP_OUT_SPEED = 1.5
/**
 * A held trigger's counting point follows it down by the highest it has read over this many trailing ms, so a jolt
 * that dips a resting finger for a few frames never lowers it (which would let the finger creep after), while an ease
 * is followed this far behind.
 */
export const XR_TRIGGER_SETTLE_MS = 60

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
/** A short pulse on a controller's first actuator, where its browser has one; nothing otherwise, never a throw. */
export const buzz = (s: XrInputSourceLike | undefined): void => {
  try { void s?.gamepad?.hapticActuators?.[0]?.pulse?.(0.6, 60)?.catch?.(() => {}) } catch { /* no actuator */ }
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
  /**
   * A drag outside the walk sector (against the way the head faced when it began) and past turnM sideways snap-turns
   * once, again only after it has come back inside turnOffM.
   */
  turnM: 0.08,
  turnOffM: 0.04,
  /** On foot it walks within this angle of forward or back, as the head faced when it began; the rest of the circle is the turn's. */
  walkSector: (50 * Math.PI) / 180,
  /** The drag's direction is smoothed with this time constant. */
  smoothMs: 100,
  /**
   * A pinch whose pose was lost this recently is no tap (it may be a hand leaving view); one untracked this long is
   * spent for walking (the hand may come back anywhere), while a shorter blink resumes against its anchor.
   */
  lostMs: 250,
  /**
   * Where the eyes sit from the point the head turns about (the neck), in the head's own frame, m: above it and in front
   * of it. The hand is measured against the neck, not the eyes, which swing through centimetres as the head turns or
   * nods (a look around would otherwise walk).
   */
  eyeUpM: 0.075,
  eyeFwdM: 0.08,
})

/**
 * The point the head turns about (the neck), from the viewer's pose: the eyes less their offset from it (eyeUpM up,
 * eyeFwdM forward in the head's frame) turned by the head's orientation, so a turn, a nod or both leave it where it is.
 * The eyes alone when the pose carries no orientation (or a broken one).
 */
export function neckOf(pose: { readonly position: XrPoint; readonly orientation?: { readonly x: number; readonly y: number; readonly z: number; readonly w: number } }): XrPoint {
  const p = pose.position, q = pose.orientation
  if (!q) return p
  const n = Math.hypot(q.x, q.y, q.z, q.w)
  if (!(n > 1e-6)) return p
  const x = q.x / n, y = q.y / n, z = q.z / n, w = q.w / n
  // v = (0, up, −fwd) turned by q: v + 2w(u×v) + 2u×(u×v), u = (x, y, z).
  const vx = 0, vy = PINCH.eyeUpM, vz = -PINCH.eyeFwdM
  const cx = y * vz - z * vy, cy = z * vx - x * vz, cz = x * vy - y * vx
  const rx = vx + 2 * (w * cx + y * cz - z * cy)
  const ry = vy + 2 * (w * cy + z * cx - x * cz)
  const rz = vz + 2 * (w * cz + x * cy - y * cx)
  return { x: p.x - rx, y: p.y - ry, z: p.z - rz }
}

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
  /** Another pinch stopped walking while this one was held: its anchor is stale, taken afresh at its next sample. */
  reanchor: boolean
  /** When the hand or the head went untracked (−1 while tracked); a blink keeps the anchor, a long loss spends it. */
  blindSince: number
  /** Untracked longer than lostMs: the hand may come back anywhere, so this pinch never walks again (pinch afresh). */
  spent: boolean
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
  /** The side of the snap that disarmed it (1 right, -1 left, 0 none): a hand seen on the other side has passed the middle. */
  private turnSide = 0
  /** The head's facing (yaw less the body's) when this drag first read: it is judged against that, so a glance does not snap. */
  private facing: number | null = null
  /** The walker's hand or the head is untracked this frame: the drag gives nothing, and its speed and snap are kept as they were. */
  private blindNow = false

  /** A drag is walking. */
  get dragging(): boolean {
    return this.walker !== null && !this.blindNow && this.level > 0
  }

  /** How many pinches are held. */
  get size(): number {
    return this.held.size
  }

  start(id: object, kind: PinchKind, transient: boolean, t: number, hand: XrPoint | null): void {
    this.dropped.delete(id)
    this.held.set(id, { kind, transient, t0: t, start: hand, ax: null, az: null, peak: 0, engaged: false, lostAt: hand === null ? t : -Infinity, reanchor: false, blindSince: -1, spent: false })
  }

  /** One headset frame: where the pinching hand and the head are (null where the hand is not tracked). */
  sample(id: object, t: number, hand: XrPoint | null, head: XrPoint | null): void {
    const p = this.held.get(id)
    if (!p) return
    if (hand === null) {
      p.lostAt = t
      this.blind(id, p, t)
      return
    }
    if (p.start === null) p.start = hand
    else p.peak = Math.max(p.peak, Math.hypot(hand.x - p.start.x, hand.y - p.start.y, hand.z - p.start.z))
    if (p.kind === 'tap') return
    if (head === null) { this.blind(id, p, t); return }
    p.blindSince = -1
    if (p.spent) return
    // The hand less the head, so a lean or a step does not walk: only the hand moving against the head does. The
    // anchor is in the reference space, so it holds across a blink of tracking and the drag simply resumes.
    const rx = hand.x - head.x, rz = hand.z - head.z
    // The first frame with both, or the first after another pinch stopped walking: the anchor is taken here.
    if (p.ax === null || p.az === null || p.reanchor) {
      p.ax = rx; p.az = rz; p.reanchor = false
      return
    }
    const dx = rx - p.ax, dz = rz - p.az
    if (!p.engaged && Math.hypot(dx, dz) > PINCH.engageM && (this.walker === null || this.walker === id)) {
      p.engaged = true
      this.walker = id
    }
    if (this.walker !== id) return
    const back = this.blindNow
    // Back from a blink on the far side of where the hand was last seen (more than a right angle round): it crossed
    // the middle unseen.
    const crossed = back && dx * this.dx + dz * this.dz < 0
    this.blindNow = false
    this.dx = dx
    this.dz = dz
    this.step(t, back, crossed)
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
    if (this.walker === id) this.dropWalker()
  }

  /** The walker stops walking: the drag halts, and a pinch held meanwhile (it could not drag) starts afresh, never with a jump. */
  private dropWalker(): void {
    this.walker = null
    this.halt()
    for (const other of this.held.values()) other.reanchor = true
  }

  /**
   * A frame without the hand or the head: the walker stands still (never the last vector, which could go on blind). A
   * blink keeps the anchor; untracked past lostMs the pinch is spent, since the hand may come back anywhere.
   */
  private blind(id: object, p: Pinch, t: number): void {
    if (p.blindSince < 0) p.blindSince = t
    if (this.walker === id) this.still()
    if (!p.spent && t - p.blindSince >= PINCH.lostMs) {
      p.spent = true
      if (this.walker === id) this.dropWalker()
    }
  }

  private halt(): void {
    this.dx = 0; this.dz = 0; this.ux = 0; this.uz = 0; this.level = 0; this.lastT = -1; this.turnArmed = true; this.turnSide = 0; this.facing = null; this.blindNow = false
  }

  /**
   * A frame with no pose for the walker: it stands still, on foot and at the wheel (never the last vector, which could go
   * on blind). Its speed step and its snap's arming are kept, so a blink neither drops it to half speed nor reads as
   * the hand coming back to the middle (which would re-arm the snap for a second turn). The smoothing goes on from
   * the last frame seen (step), so tracking that drops every other frame is smoothed as before.
   */
  private still(): void {
    this.blindNow = true
  }

  /**
   * The speed step and the smoothed direction from this frame's draw. `back`: the first frame after a blink;
   * `crossed`: the hand came back on the far side of where it was last seen, so it is taken as a pass through the dead
   * zone would be: the speed steps up afresh from nothing and the direction is the one it lies in now, never the old
   * way walked on at speed. A hand last seen in the dead zone has no heading to smooth from either.
   */
  private step(t: number, back = false, crossed = false): void {
    const d = Math.hypot(this.dx, this.dz)
    if (crossed) this.level = 0
    const fresh = crossed || (back && this.level === 0)
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
      const k = fresh || this.lastT < 0 || this.level === 0 ? 1 : 1 - Math.exp(-Math.max(0, t - this.lastT) / PINCH.smoothMs)
      this.ux += (nx - this.ux) * k
      this.uz += (nz - this.uz) * k
      const m = Math.hypot(this.ux, this.uz)
      if (m > 1e-6) { this.ux /= m; this.uz /= m }
    }
    this.lastT = t
  }

  /**
   * Writes the drag into `out` (zeroed by the caller) and takes any snap it earned. On foot the drag is judged as the
   * head faced when it began (`headOffset`, the head's yaw less the body's): within walkSector of that forward or back it walks,
   * in the direction the hand moved; further round and past turnM sideways it snap-turns once; drawn past runM it runs.
   * At the wheel x steers and z drives. False when it gives nothing.
   */
  read(out: Analog, driving: boolean, headOffset = 0): boolean {
    if (this.walker === null || this.blindNow) return false
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
    // Into the head's frame as it faced when the drag began (x right, y forward), the inverse of XrMapper.toHead: a
    // glance aside mid-drag changes nothing, and a snap turns the body and the space together, so it holds after one.
    if (this.facing === null) this.facing = Number.isFinite(headOffset) ? headOffset : 0
    const o = this.facing
    const c = Math.cos(o), sn = Math.sin(o)
    const hx = dx * c - dz * sn, hy = -dz * c - dx * sn
    const ux = this.ux * c - this.uz * sn, uy = -this.uz * c - this.ux * sn
    const side = Math.abs(hx)
    if (this.turnArmed && side > PINCH.turnM && Math.atan2(side, Math.abs(hy)) > PINCH.walkSector) {
      this.turn += hx > 0 ? XR_TURN.step : -XR_TURN.step
      this.turnArmed = false
      this.turnSide = hx > 0 ? 1 : -1
    } else if (!this.turnArmed && (side < PINCH.turnOffM || hx * this.turnSide < 0)) this.turnArmed = true
    if (this.level === 0 || Math.atan2(Math.abs(ux), Math.abs(uy)) > PINCH.walkSector) return false
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
  /** The walking hand's click held at the wheel: since when, since when the car has stood, and whether it was refused. */
  private readonly hold = new WeakMap<object, { at: number; still: number; refused: boolean }>()
  /** Each source's duty last frame, for a trigger that takes on the throttle while held. */
  private readonly lastRole = new WeakMap<object, XrRole>()
  /**
   * Sources whose trigger was held into the wheel (the press that opened the door, a light finger, a worn trigger's
   * rest): the lowest raw value it has eased back to since, which its throttle counts from. Gone once it is let go,
   * and on foot.
   */
  private readonly triggerBase = new WeakMap<object, number>()
  /**
   * The trigger's readings over the last XR_TRIGGER_SETTLE_MS while a base is held, highest first (a falling run of
   * [time, raw] pairs: the front is the window's highest), for the base to follow down.
   */
  private readonly triggerRecent = new WeakMap<object, number[]>()
  private wasDriving = false
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
  use(s?: XrInputSourceLike): number {
    if (this.driving) return this.leave(s)
    return this.nearCar ? PAD_EDGE.interact : PAD_EDGE.ping
  }

  /**
   * The car's door, the button for it: on foot the interaction (a door in reach, a shop's or a home's card); at the wheel
   * out only once the car has stopped, since a corrective press at speed is easily made by mistake and a step out of a
   * moving car is hard on a headset's wearer. A refusal is said (`takeRefused`) and buzzed on the controller that asked.
   */
  leave(s?: XrInputSourceLike): number {
    if (!this.driving || this.stopped) return PAD_EDGE.interact
    this.refusedFlag = true
    buzz(s)
    return 0
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
    if (!list) { this.turn = 0; out.run = this.run; this.wasDriving = this.driving; return 0 }
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
      // A controller that can toggle the run latch in its present duty (the walking hand's click, a lone stick's).
      if ((role === 'left' && (shape.stick || shape.padWalks)) || (role === 'both' && shape.stick)) latchable++
      // Edges: a source first seen only teaches what it holds (a button held as it woke, or came back, is no press).
      const known = this.bits.has(s)
      const prev = this.bits.get(s) ?? 0
      let bits = 0
      for (let b = 0; b <= XR_BUTTON.secondary; b++) if (pressed(s, b)) bits |= 1 << b
      this.bits.set(s, bits)
      const rising = known ? bits & ~prev : 0
      const press = (b: number) => (rising & (1 << b)) !== 0
      const holding = (b: number) => (bits & (1 << b)) !== 0
      // A trigger held into the wheel (the press that opened the door, held as the controller woke there or as it takes
      // on the throttle; a light finger as much as a press, a worn trigger's rest too) gives no throttle where it is:
      // it counts only what it is pulled past the lowest point it has eased back to since, judged by the highest it read
      // over the trailing XR_TRIGGER_SETTLE_MS so a jolt's brief dip is not taken for one (that plus the dead zone; the
      // travel left is stretched to full throttle, but never more than twice the plain gain, so a wobble near the stop
      // is no lurch). So the car never lurches on the way in nor creeps on a resting finger or a worn trigger. The point
      // is taken afresh at each of those moments (never kept from an earlier car or duty) and dropped on foot; let go
      // (back inside the dead zone) it counts from nothing.
      const was = this.lastRole.get(s)
      const takesThrottle = (role === 'right' || role === 'both') && was !== 'right' && was !== 'both'
      this.lastRole.set(s, role)
      const tb = g.buttons[XR_BUTTON.trigger]
      const pull = triggerValue(tb)
      const raw = tb ? (tb.value > 0 ? tb.value : tb.pressed ? 1 : 0) : 0
      let base = this.triggerBase.get(s)
      if (pull === 0 || !this.driving) base = undefined
      else if (!this.wasDriving || !known || takesThrottle) { base = raw; this.triggerRecent.delete(s) }
      if (base === undefined) {
        this.triggerBase.delete(s)
        this.triggerRecent.delete(s)
      } else {
        // The window's highest reading: a falling run of [time, raw] pairs, newest last, oldest dropped past the window.
        let run = this.triggerRecent.get(s)
        if (!run) { run = []; this.triggerRecent.set(s, run) }
        while (run.length > 0 && run[run.length - 1] <= raw) run.length -= 2
        run.push(now, raw)
        while (run.length > 2 && run[0] < now - XR_TRIGGER_SETTLE_MS) run.splice(0, 2)
        base = Math.min(base, run[1])
        this.triggerBase.set(s, base)
      }
      const from = base === undefined ? 0 : base + PAD_TUNING.triggerDeadzone
      const throttle = base === undefined ? pull : Math.min(1, Math.max(0, (raw - from) / Math.max(0.5, 1 - from)))
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
      // wheel, held for XR_HOLD_OUT_MS while the car stays stopped, it steps out (the left hand's, and a lone stick
      // controller's with no upper face button, which has no other door; a lone one with that button keeps the click for
      // the handbrake). The second counts only while stopped, so a click held through a stop is no exit.
      const clickBtn = shape.stick ? XR_BUTTON.thumbstick : shape.padWalks ? XR_BUTTON.touchpad : -1
      const holdOut = clickBtn >= 0 && (role === 'left' || (role === 'both' && shape.stick && shape.faces < 2))
      if (holdOut && holding(clickBtn) && this.driving) {
        let h = this.hold.get(s)
        // A click held into the wheel (down before the car was) never counts: at Infinity.
        if (!h) { h = { at: press(clickBtn) ? now : Infinity, still: -1, refused: false }; this.hold.set(s, h) }
        if (Number.isFinite(h.at)) {
          if (!this.stopped) {
            h.still = -1
            // Held a second while the car rolls: refused like any door (said, buzzed), once; it then waits for a stop.
            if (!h.refused && now - h.at >= XR_HOLD_OUT_MS) { h.refused = true; this.refusedFlag = true; buzz(s) }
          } else {
            if (h.still < 0) h.still = now
            if (now - h.still >= XR_HOLD_OUT_MS) { edges |= PAD_EDGE.interact; h.at = Infinity }
          }
        }
      } else this.hold.delete(s)
      if (role === 'both') {
        // Alone: forward and back walk; sideways a stick snap-turns (by sectors, never both at once) while a touchpad
        // turns only on an edge click (a thumb resting at the edge before and after the click is no second turn); at
        // the wheel it steers and drives.
        if (this.driving) {
          steer = -sx || 0; mx = sx; my = -sy || 0
          if (shape.stick && shape.faces >= 2 && holding(XR_BUTTON.thumbstick)) out.handbrake = true
        } else {
          const m = Math.hypot(sx, sy)
          if (m > 0) {
            const fromSide = Math.atan2(Math.abs(sy), Math.abs(sx))
            if (fromSide <= XR_SECTOR.snap) { if (shape.stick) turn = sx }
            else if (Math.PI / 2 - fromSide <= XR_SECTOR.walk) my = -sy || 0
          }
          if (shape.padWalks && rim) out.run = true
          if (clickBtn === XR_BUTTON.thumbstick && press(XR_BUTTON.thumbstick)) this.run = !this.run
        }
        out.throttle = Math.max(out.throttle, throttle)
        out.brake = Math.max(out.brake, triggerValue(g.buttons[XR_BUTTON.squeeze]))
        if (!this.driving && press(XR_BUTTON.trigger)) edges |= this.use(s)
        if (shape.faces >= 1 && press(XR_BUTTON.primary)) edges |= PAD_EDGE.ping
        if (shape.faces >= 2 && press(XR_BUTTON.secondary)) edges |= this.leave(s)
        if (shape.pad && press(XR_BUTTON.touchpad)) {
          // A touchpad that walks: a centre click is what is at hand, an edge click snap-turns on foot. One beside a
          // stick (no upper face button to leave by) is the door, what is at hand on foot.
          if (shape.padWalks && !this.driving && Math.abs(padX) > XR_PAD_EDGE) this.padSnapStep(padX)
          else if (shape.padWalks || shape.faces < 2) edges |= this.use(s)
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
        out.throttle = Math.max(out.throttle, throttle)
        out.brake = Math.max(out.brake, triggerValue(g.buttons[XR_BUTTON.squeeze]))
        if (shape.faces >= 1 && press(XR_BUTTON.primary)) edges |= PAD_EDGE.ping
        if (shape.faces >= 2 && press(XR_BUTTON.secondary)) edges |= this.leave(s)
        if (shape.stick && press(XR_BUTTON.thumbstick)) edges |= PAD_EDGE.mute
        if (shape.faces < 2 && shape.pad && press(XR_BUTTON.touchpad)) {
          // No upper face button: the touchpad's click is the door; a pad that turns snaps on an edge click on foot.
          if (shape.padWalks && !this.driving && Math.abs(padX) > XR_PAD_EDGE) this.padSnapStep(padX)
          else edges |= this.leave(s)
        } else if (shape.padWalks && press(XR_BUTTON.touchpad) && !this.driving && Math.abs(padX) > XR_PAD_EDGE) this.padSnapStep(padX)
        // No upper face button: the trigger on foot does what is at hand too (a stick controller's button 2 may be a
        // placeholder that never presses, and nothing tells it from a real touchpad's).
        if (shape.faces < 2 && !this.driving && press(XR_BUTTON.trigger)) edges |= this.use(s)
      }
      if (bits !== 0 || sx !== 0 || sy !== 0 || Math.abs(turn) > XR_DEADZONE) { this.used = true; this.active = true }
    }
    // No controller that can toggle the run latch is left (put down for hands, or a lone touchpad): the latch goes.
    if (latchable === 0) this.run = false
    this.wasDriving = this.driving
    out.run = out.run || this.run
    // On foot, the stick in the head's frame: forward is where the headset looks, not where the body stands.
    const v = this.headVec
    v.moveX = mx; v.moveY = my
    this.toHead(v)
    mx = v.moveX; my = v.moveY
    // A pinch's drag, already in the body's frame: the larger of it and the sticks moves.
    const p = this.pinchOut
    zeroAnalog(p)
    if (this.pinches.read(p, this.driving, this.driving ? 0 : this.headOffset)) {
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
    this.wasDriving = false
    this.pinches.clear()
  }
}
