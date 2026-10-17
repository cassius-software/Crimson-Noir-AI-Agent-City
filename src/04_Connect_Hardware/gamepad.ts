// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the Gamepad API driver: it reads W3C "standard"-mapped pads (and the
 * HAL's HID-decoded DualSense, which uses the same shape; a pad without the mapping is read by position, as a
 * best guess, GenericPads) into one Analog frame plus edge-triggered
 * actions — radial dead zones, a quadratic look curve, the L3 run latch — names pads for the HAL, tells
 * which controller family was used last (for the HUD's button glyphs), and turns the right stick into
 * first-person head motion (PadLook). It is pure (no DOM), so every mapping is unit-tested in Node.
 * What breaks if it is removed? Controllers stop driving, walking and looking.
 *
 * Standard mapping (w3c.github.io/gamepad/#remapping): buttons 0 south (A/Cross), 1 east (B/Circle),
 * 2 west (X/Square), 3 north (Y/Triangle), 4/5 L1/R1, 6/7 L2/R2 (analog), 8 select, 9 start, 10/11 L3/R3,
 * 12–15 d-pad up/down/left/right, 16 home; axes 0/1 left stick, 2/3 right stick, +x right, +y down.
 */
import type { GamepadButtonLike, GamepadLike } from './web-hardware.d.ts'

/** Merged analog intent. moveY > 0 = forward, steer > 0 = left (like the A key), look +x right, +y up. */
export interface Analog {
  moveX: number
  moveY: number
  lookX: number
  lookY: number
  /** 0..1 */
  throttle: number
  /** 0..1 */
  brake: number
  /** −1..1 */
  steer: number
  run: boolean
  handbrake: boolean
}

export function createAnalog(): Analog {
  return { moveX: 0, moveY: 0, lookX: 0, lookY: 0, throttle: 0, brake: 0, steer: 0, run: false, handbrake: false }
}

export function zeroAnalog(a: Analog): void {
  a.moveX = 0; a.moveY = 0; a.lookX = 0; a.lookY = 0; a.throttle = 0; a.brake = 0; a.steer = 0
  a.run = false; a.handbrake = false
}

export const PAD = {
  south: 0, east: 1, west: 2, north: 3, l1: 4, r1: 5, l2: 6, r2: 7, select: 8, start: 9, l3: 10, r3: 11,
  up: 12, down: 13, left: 14, right: 15, home: 16,
} as const

export const PAD_TUNING = {
  /** Radial stick dead zone; the rest of the travel is rescaled to 0..1. */
  stickDeadzone: 0.14,
  triggerDeadzone: 0.04,
  /** A button counts as pressed above this value even if `pressed` lags (some drivers). */
  press: 0.5,
} as const

/** Edge bits returned by PadMapper.read(). */
export const PAD_EDGE = { interact: 1, reset: 2, timeForward: 4, timeBack: 8, ping: 16 } as const

/**
 * Radial dead zone with rescale; square-gate corners are clamped to magnitude 1. NaN or ±Infinity (a broken
 * driver) reads as centred: the result steers a physics body, so it must always be finite.
 */
export function radialDeadzone(x: number, y: number, dz: number, out: { x: number; y: number }): void {
  const m = Math.hypot(x, y)
  if (!(m > dz) || m === Infinity) { out.x = 0; out.y = 0; return }
  const k = Math.min(1, (m - dz) / (1 - dz)) / m
  out.x = x * k
  out.y = y * k
}

export function triggerValue(b: GamepadButtonLike | undefined, dz: number = PAD_TUNING.triggerDeadzone): number {
  if (!b) return 0
  const v = b.value > 0 ? b.value : b.pressed ? 1 : 0
  return v > dz ? Math.min(1, (v - dz) / (1 - dz)) : 0
}

function isPressed(b: GamepadButtonLike | undefined): boolean {
  return b !== undefined && (b.pressed || b.value > PAD_TUNING.press)
}

/**
 * USB vendor/product from a pad id. Chromium: "… (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)";
 * Firefox: "54c-ce6-…". Safari exposes neither (null).
 */
export function parsePadId(id: string): { vendor: number; product: number } | null {
  const chrome = /Vendor:\s*([0-9a-f]{1,4})\s+Product:\s*([0-9a-f]{1,4})/i.exec(id)
  const m = chrome ?? /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-/i.exec(id)
  return m ? { vendor: parseInt(m[1], 16), product: parseInt(m[2], 16) } : null
}

/** Human name without the browser's mapping/vendor decorations. */
export function padName(id: string): string {
  const name = id
    .replace(/\s*\([^)]*(?:STANDARD GAMEPAD|Vendor:)[^)]*\)\s*$/i, '')
    .replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, '')
    .trim()
  return (name || 'Gamepad').slice(0, 48)
}

export function isStandardPad(p: GamepadLike | null | undefined): p is GamepadLike {
  return !!p && p.connected && p.mapping === 'standard'
}

/**
 * A pad the city reads: a standard one, or one without the standard mapping that has a stick and four buttons
 * (GenericPads reads it by position, as a best guess). The HAL passes on such a pad only once one of its first four
 * buttons has been pressed (hal.ts readPads), so a flight stick, a wheel or a throttle quadrant left on the desk never
 * takes a seat or moves anyone.
 */
export function isUsablePad(p: GamepadLike | null | undefined): p is GamepadLike {
  return !!p && p.connected && (p.mapping === 'standard' || (p.axes.length >= 2 && p.buttons.length >= 4))
}

/** How GenericPads read a pad without the standard mapping (the HAL's line for it says "best guess by position"). */
export type GenericLayout = 'evdev' | 'four-axis' | 'stick-only'

/** A stick axis within this of 0 is centred: one is read only once it has rested there. */
const CENTRED = PAD_TUNING.stickDeadzone
/** A trigger axis at or below this is at rest (the Linux kernel's triggers rest at −1, their minimum). */
const AT_REST = -0.9
/** A stick or a hat at rest holds its value to within this (an 8-bit pad's last count flickers by 0.008); a thumb, a
 *  finger or a foot holding a stick, a trigger or a pedal near its middle drifts further. */
const STEADY = 0.02

/**
 * How long a pattern must hold, in milliseconds of reading (one read counts for at most `gap`, so a tab in the
 * background or a stalled frame never counts as time spent at rest), before it is a rest rather than a pass:
 * - rest: the kernel's order is taken once its triggers have sat at their low end that long with every stick centred,
 *   and dropped once axes 2 and 5 have both sat centred and steady that long.
 * - settle: an axis first seen off centre is read as a stick only once it has sat centred and steady that long: a
 *   stick held as the pad wakes rests there once let go, where a pedal, a trigger or a lever resting at an end only
 *   passes through the middle, or wavers there under a foot or a finger.
 */
export const GENERIC_MS = { rest: 500, settle: 1500, gap: 100 } as const

interface GenericView {
  id: string
  layout: GenericLayout
  /** Per axis, off centre at the first read: held, or resting at an end (a pedal, a trigger, a lever). */
  off: Uint8Array
  /** Per axis, where its current steady run began (a run ends when it leaves the centre or drifts past STEADY). */
  anchor: Float32Array
  /** Per axis, milliseconds it has sat centred and steady. */
  still: Float64Array
  /** Per axis, read as a stick: seen resting centred, so read from then on. */
  centred: Uint8Array
  /** Per axis, read as a trigger: seen at rest since the pad appeared, so read from then on. */
  rested: Uint8Array
  /** Milliseconds the kernel's order has shown its signature. */
  order: number
  /** The kernel's order was taken and then dropped: a stick and a hat stand on axes 2 and 5, so never again. */
  dropped: boolean
  /** When the last read was (the reads' clock), or −1 before the first. */
  at: number
  axes: number[]
  buttons: { pressed: boolean; value: number }[]
  pad: GamepadLike
}

/**
 * Pads whose browser reports no standard mapping (mapping ''), turned into a standard-shaped view by position. Most
 * still put the left stick on axes 0/1 and the face buttons first, so those always map (walk, steer with the stick,
 * which also drives: controls.ts reads stick Y as throttle; south enters a car, east is the handbrake). Nothing is
 * known of an axis until it is seen doing what its part does, so nothing moves on its own:
 * - an axis read as a stick counts only once it has been seen resting centred: at once for one centred at the first
 *   read, and for one off centre then only after sitting centred and steady for GENERIC_MS.settle. A stick held as the
 *   pad wakes comes alive a moment after it is let go; a pedal or a lever resting at an end, or a slider parked off
 *   centre, never drives or turns anyone, even after passing through the middle or pausing there;
 * - an axis read as a trigger counts only once it has been seen at rest, at its low end: one held when the pad appears,
 *   or one a browser reports as 0 until it is first pressed (Firefox), reads nothing rather than half a pull.
 * The layout:
 * - 'evdev': six or more axes, taken once axes 2 and 5 have sat at their low end, with axes 0, 1, 3 and 4 centred, for
 *   GENERIC_MS.rest. That is the Linux kernel's order for a pad with analog triggers (left stick, left trigger, right
 *   stick, right trigger, then the d-pad as two axes), which Firefox and Chromium on Linux pass through for a pad they
 *   do not know (and HID's own order, X Y Z Rx Ry Rz, elsewhere): the right stick looks, the triggers brake and
 *   throttle, the d-pad steps the clock, and the buttons after the shoulders are remapped to select, start, home and
 *   the stick clicks. Until then the pad reads as 'stick-only', so a browser that hides the triggers' rest until they
 *   are pressed gets the full layout once they have been. Other orders put a stick or a hat there (the joystick
 *   driver's X Y Z Rz and hat; Chromium on Windows puts a pad's right stick on axes 2 and 5): one held at that end for
 *   GENERIC_MS.rest is taken for the kernel's order, and until axes 2 and 5 have both sat centred and steady for
 *   GENERIC_MS.rest it brakes and throttles as it moves (at half when centred); then the order is dropped for good.
 *   Two real triggers held steady at half pull together that long drop it too: the rare cost, until the pad
 *   reconnects.
 * - 'four-axis': exactly four axes: the right stick is axes 2/3 (most HID pads); buttons past the shoulders are
 *   dropped, since their order differs from pad to pad.
 * - 'stick-only': anything else: the left stick and the first six buttons; no look, so a mislabelled axis never
 *   spins the head.
 * One view per slot, made when a pad first appears there; each read only copies numbers into it.
 */
export class GenericPads {
  private readonly views: (GenericView | null)[] = Array.from({ length: SLOTS }, () => null)

  /**
   * The standard-shaped view of `p` (a pad isUsablePad accepts that is not standard), refreshed from its state as read
   * at `at` (milliseconds on any steady clock: performance.now() in the page, a counter in tests).
   */
  view(p: GamepadLike, at: number): GamepadLike {
    const slot = p.index & (SLOTS - 1)
    let v = this.views[slot]
    if (!v || v.id !== p.id) v = this.views[slot] = GenericPads.make(p)
    GenericPads.observe(v, p, at)
    const out = v.axes, b = v.buttons
    for (let k = 0; k < b.length; k++) { b[k].pressed = false; b[k].value = 0 }
    out[0] = stickAxis(p, v, 0)
    out[1] = stickAxis(p, v, 1)
    out[2] = 0
    out[3] = 0
    for (let k = 0; k < 6; k++) copyButton(p, k, b[k])
    if (v.layout === 'evdev') {
      out[2] = stickAxis(p, v, 3)
      out[3] = stickAxis(p, v, 4)
      triggerAxis(p, v, 2, b[PAD.l2])
      triggerAxis(p, v, 5, b[PAD.r2])
      copyButton(p, 6, b[PAD.select])
      copyButton(p, 7, b[PAD.start])
      copyButton(p, 8, b[PAD.home])
      copyButton(p, 9, b[PAD.l3])
      copyButton(p, 10, b[PAD.r3])
      // A hat rests centred like a stick: two axes that never have (sliders, say) step no clock.
      const hx = stickAxis(p, v, 6), hy = stickAxis(p, v, 7)
      hatButton(b[PAD.left], hx < -0.5)
      hatButton(b[PAD.right], hx > 0.5)
      hatButton(b[PAD.up], hy < -0.5)
      hatButton(b[PAD.down], hy > 0.5)
    } else if (v.layout === 'four-axis') {
      out[2] = stickAxis(p, v, 2)
      out[3] = stickAxis(p, v, 3)
    }
    return v.pad
  }

  /** How the pad in this slot is read, or null for none seen there. */
  layoutOf(index: number): GenericLayout | null {
    return this.views[index & (SLOTS - 1)]?.layout ?? null
  }

  /** The slot's pad went away: the next one there is measured afresh. */
  forget(slot: number): void {
    this.views[slot & (SLOTS - 1)] = null
  }

  private static make(p: GamepadLike): GenericView {
    const n = p.axes.length
    const axes = [0, 0, 0, 0]
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }))
    const pad: GamepadLike = { id: p.id, index: p.index, connected: true, mapping: 'standard', timestamp: 0, axes, buttons }
    const off = new Uint8Array(n), anchor = new Float32Array(n), centred = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      anchor[i] = axisAt(p, i)
      off[i] = Math.abs(anchor[i]) > CENTRED ? 1 : 0
      centred[i] = 1 - off[i]
    }
    return {
      id: p.id, layout: n === 4 ? 'four-axis' : 'stick-only', off, anchor, still: new Float64Array(n), centred,
      rested: new Uint8Array(n), order: 0, dropped: false, at: -1, axes, buttons, pad,
    }
  }

  /** What this read shows about each axis, and whether the kernel's order holds. */
  private static observe(v: GenericView, p: GamepadLike, at: number): void {
    const dt = v.at < 0 ? 0 : Math.min(GENERIC_MS.gap, Math.max(0, at - v.at))
    v.at = at
    const n = Math.min(p.axes.length, v.centred.length)
    for (let i = 0; i < n; i++) {
      const x = axisAt(p, i)
      if (Math.abs(x) <= CENTRED && Math.abs(x - v.anchor[i]) <= STEADY) v.still[i] += dt
      else { v.anchor[i] = x; v.still[i] = 0 }
      if (v.off[i] && v.still[i] >= GENERIC_MS.settle) v.centred[i] = 1
      if (x <= AT_REST) v.rested[i] = 1
    }
    if (n < 6) return
    if (v.layout === 'evdev') {
      // Axes 2 and 5 both resting centred: a stick and a hat stand there, not two triggers.
      if (v.still[2] >= GENERIC_MS.rest && v.still[5] >= GENERIC_MS.rest) { v.layout = 'stick-only'; v.dropped = true }
      return
    }
    if (v.dropped) return
    const centred = (i: number) => Math.abs(axisAt(p, i)) <= CENTRED
    const shows = axisAt(p, 2) <= AT_REST && axisAt(p, 5) <= AT_REST && centred(0) && centred(1) && centred(3) && centred(4)
    v.order = shows ? v.order + dt : 0
    if (v.order >= GENERIC_MS.rest) v.layout = 'evdev'
  }
}

/** Axis `i`, centred when missing or broken. */
function axisAt(p: GamepadLike, i: number): number {
  const x = p.axes[i]
  return Number.isFinite(x) ? x : 0
}

/** Axis `i` as a stick: nothing until it has been seen resting centred. */
function stickAxis(p: GamepadLike, v: GenericView, i: number): number {
  return v.centred[i] ? axisAt(p, i) : 0
}

/** Axis `i` as a trigger: from rest (−1) to fully pulled (+1) is 0..1, nothing until it has been seen at rest. */
function triggerAxis(p: GamepadLike, v: GenericView, i: number, to: { pressed: boolean; value: number }): void {
  const t = v.rested[i] ? Math.max(0, Math.min(1, (axisAt(p, i) + 1) / 2)) : 0
  to.value = t
  to.pressed = t > PAD_TUNING.press
}

function copyButton(p: GamepadLike, from: number, to: { pressed: boolean; value: number }): void {
  const src = p.buttons[from]
  if (!src) return
  to.pressed = src.pressed
  to.value = Number.isFinite(src.value) ? src.value : 0
}

function hatButton(to: { pressed: boolean; value: number }, on: boolean): void {
  to.pressed = on
  to.value = on ? 1 : 0
}

/** The first four buttons, a pad's face buttons on every layout: one pressed wakes a pad without the standard mapping (hal.ts). */
export function pressesFaceButton(p: GamepadLike): boolean {
  for (let k = 0; k < 4; k++) if (isPressed(p.buttons[k])) return true
  return false
}

/**
 * Which labels a controller carries, by layout (glyphs.ts names each): 'abxy' letters with A at the south
 * button, 'bayx' letters with B there, 'numbered' shoulders and stick clicks (L1 L2 L3) with unlettered face
 * buttons, 'generic' when nobody recognised the pad (every control named by position).
 */
export type PadFamily = 'abxy' | 'bayx' | 'numbered' | 'generic'

/** The layout behind each console maker's USB vendor id (USB-IF assignments; 0x054c is also the DualSense's,
 *  hal.ts), and Valve's 0x28de: Steam Input's virtual pad and the Steam Deck put A at the south button. */
export const PAD_VENDOR_LAYOUT: Readonly<Record<number, PadFamily>> = { 0x054c: 'numbered', 0x045e: 'abxy', 0x057e: 'bayx', 0x28de: 'abxy' }

/**
 * A pad's layout from its id: the USB vendor when the browser reports one. Ids without a vendor fall back to what
 * they say: Chromium on Windows marks every XInput pad "(XInput …)" (the letters layout), the HAL's HID-decoded
 * DualSense is "DualSense (HID)", and Safari names the PlayStation pads. Anything else is generic: named by position,
 * never mislabelled.
 */
export function padFamilyOf(id: string): PadFamily {
  const vendor = parsePadId(id)?.vendor
  if (vendor !== undefined && PAD_VENDOR_LAYOUT[vendor]) return PAD_VENDOR_LAYOUT[vendor]
  if (/dualsense|dualshock/i.test(id)) return 'numbered'
  if (/\bxinput\b/i.test(id)) return 'abxy'
  return 'generic'
}

const SLOTS = 32

/**
 * Reads pads into an Analog frame. Several pads merge: the stick deflected furthest wins, triggers take
 * the maximum, buttons OR together. Allocation-free per read (a pad's family is worked out once per id).
 */
export class PadMapper {
  /** Latched once any pad produces input; cleared when no standard pad remains. */
  used = false
  /** Any input beyond the dead zones during the last read. */
  active = false
  /** L3 run latch: on with an L3 click, off with another click or when the left stick returns to centre. */
  running = false
  /**
   * Family of the standard pad used most recently; when that pad goes away, of a pad still connected; null
   * before any pad has produced input and once every pad is gone.
   */
  family: PadFamily | null = null
  private readonly prev = new Uint32Array(SLOTS)
  private readonly seen = new Uint8Array(SLOTS)
  /** The slots read last time: a pad absent then is new this read. */
  private readonly before = new Uint8Array(SLOTS)
  private readonly v = { x: 0, y: 0 }
  /** Slot of the pad used most recently, −1 = none. */
  private lastSlot = -1
  private familyId = ''
  /** Pads without the standard mapping, read by position. */
  readonly generic = new GenericPads()
  /** The reads' clock in milliseconds (GenericPads time how long a pad's axes hold still). */
  private readonly now: () => number

  constructor(now: () => number = () => performance.now()) {
    this.now = now
  }

  /** Fills `out` (zeroed first) and returns PAD_EDGE bits for buttons that went down since the last read. */
  read(pads: ArrayLike<GamepadLike | null | undefined> | null, out: Analog): number {
    zeroAnalog(out)
    this.seen.fill(0)
    let edges = 0, count = 0, any = false, bestMove = 0, bestLook = 0, l3 = false
    let firstPad: GamepadLike | null = null, lastPad: GamepadLike | null = null
    const dz = PAD_TUNING.stickDeadzone, v = this.v
    const n = pads ? pads.length : 0
    let at = -1
    for (let i = 0; i < n; i++) {
      const raw = pads![i]
      if (!isUsablePad(raw)) continue
      const standard = isStandardPad(raw)
      if (!standard && at < 0) at = this.now()
      const p = standard ? raw : this.generic.view(raw, at)
      count++
      firstPad ??= p
      const slot = p.index & (SLOTS - 1)
      this.seen[slot] = 1
      const ax = p.axes
      radialDeadzone(ax[0] ?? 0, ax[1] ?? 0, dz, v)
      const move = v.x * v.x + v.y * v.y
      if (move > bestMove) { bestMove = move; out.moveX = v.x; out.moveY = -v.y; out.steer = -v.x }
      radialDeadzone(ax[2] ?? 0, ax[3] ?? 0, dz, v)
      const look = v.x * v.x + v.y * v.y
      // Radial quadratic curve: fine control near the centre, full rate at the rim in every direction.
      if (look > bestLook) { const m = Math.sqrt(look); bestLook = look; out.lookX = v.x * m; out.lookY = -v.y * m }
      const b = p.buttons
      const brake = triggerValue(b[PAD.l2]), throttle = triggerValue(b[PAD.r2])
      if (throttle > out.throttle) out.throttle = throttle
      if (brake > out.brake) out.brake = brake
      let bits = 0
      const nb = Math.min(b.length, SLOTS)
      for (let k = 0; k < nb; k++) if (isPressed(b[k])) bits |= 1 << k
      bits >>>= 0
      // A pad without the standard mapping arrives with the face button that woke it (hal.ts) held: that press only
      // wakes it, it never enters a car or resets one.
      if (!standard && !this.before[slot]) this.prev[slot] = bits
      const rising = (bits & ~this.prev[slot]) >>> 0
      this.prev[slot] = bits
      if (rising & (1 << PAD.south)) edges |= PAD_EDGE.interact
      if (rising & (1 << PAD.north)) edges |= PAD_EDGE.reset
      if (rising & (1 << PAD.left)) edges |= PAD_EDGE.timeBack
      if (rising & (1 << PAD.right)) edges |= PAD_EDGE.timeForward
      // The right shoulder: a ping, reachable with the thumbs on the sticks, walking or steering.
      if (rising & (1 << PAD.r1)) edges |= PAD_EDGE.ping
      if (rising & (1 << PAD.l3)) l3 = true
      if (bits & (1 << PAD.east)) out.handbrake = true
      if (bits !== 0 || move > 0 || look > 0 || throttle > 0 || brake > 0) {
        any = true
        lastPad = p
        this.lastSlot = slot
      }
    }
    for (let s = 0; s < SLOTS; s++) if (!this.seen[s]) { this.prev[s] = 0; this.generic.forget(s) }
    this.before.set(this.seen)
    if (l3) this.running = !this.running
    else if (bestMove === 0) this.running = false
    out.run = this.running
    this.active = any
    if (any) this.used = true
    if (count === 0) { this.used = false; this.running = false; this.lastSlot = -1 }
    this.trackFamily(lastPad, firstPad)
    return edges
  }

  /** Follows the pad used last; if it was unplugged, a pad that is still connected stands in for it. */
  private trackFamily(used: GamepadLike | null, fallback: GamepadLike | null): void {
    if (!this.used) {
      this.family = null
      this.familyId = ''
      return
    }
    const pad = used ?? (this.lastSlot >= 0 && this.seen[this.lastSlot] ? null : fallback)
    if (!pad) return
    if (this.lastSlot < 0 || !this.seen[this.lastSlot]) this.lastSlot = pad.index & (SLOTS - 1)
    if (pad.id === this.familyId && this.family !== null) return
    this.familyId = pad.id
    this.family = padFamilyOf(pad.id)
  }
}

/**
 * First-person head motion from the right stick. Rates are at full deflection (after the radial quadratic
 * curve): about 140°/s to turn, slower to nod — quick enough to check a crossing, calm enough to stay
 * comfortable. Holding the stick hard sideways ramps the turn up (to about 210°/s) for an about-face. The
 * rate eases in over a few frames like a head's inertia and eases out faster, so releasing the stick stops
 * the view almost at once.
 */
export const PAD_LOOK = {
  /** rad/s at full deflection */
  yawRate: 2.4,
  pitchRate: 1.6,
  /** Extra yaw rate reached after holding the rim, rad/s. */
  boost: 1.3,
  /** Horizontal look (after the curve) that counts as holding the rim. */
  rim: 0.8,
  /** s at the rim before the boost starts, then s to reach it fully. */
  boostDelay: 0.3,
  boostRamp: 0.45,
  /** Time constants of the rate smoothing, s: speeding up, and slowing down or reversing. */
  easeIn: 0.07,
  easeOut: 0.025,
} as const

export class PadLook {
  /** Current head rates, rad/s: yaw + = turning right, pitch + = looking up. */
  yawRate = 0
  pitchRate = 0
  /** s the stick has been held at the horizontal rim. */
  private rimHeld = 0

  /**
   * Advances by `dt` seconds with the curved look axes (Analog.lookX / lookY, −1..1) and writes the head
   * deltas for this frame into `out` (radians; yaw + = right, pitch + = up). Allocation-free.
   */
  step(lookX: number, lookY: number, dt: number, out: { yaw: number; pitch: number }): void {
    const t = dt > 0 ? Math.min(dt, 0.1) : 0
    const lx = Number.isFinite(lookX) ? Math.max(-1, Math.min(1, lookX)) : 0
    const ly = Number.isFinite(lookY) ? Math.max(-1, Math.min(1, lookY)) : 0
    this.rimHeld = Math.abs(lx) >= PAD_LOOK.rim ? this.rimHeld + t : 0
    const boost = Math.max(0, Math.min(1, (this.rimHeld - PAD_LOOK.boostDelay) / PAD_LOOK.boostRamp))
    const yaw0 = this.yawRate, pitch0 = this.pitchRate
    this.yawRate = ease(yaw0, lx * (PAD_LOOK.yawRate + PAD_LOOK.boost * boost), t)
    this.pitchRate = ease(pitch0, ly * PAD_LOOK.pitchRate, t)
    // Trapezoid: the rate changes linearly across the frame.
    out.yaw = (yaw0 + this.yawRate) * 0.5 * t
    out.pitch = (pitch0 + this.pitchRate) * 0.5 * t
  }

  /** Stops the head at once (focus lost, terminal opened). */
  reset(): void {
    this.yawRate = 0
    this.pitchRate = 0
    this.rimHeld = 0
  }
}

/** Below this (0.3°/s) a head whose stick is centred has stopped. */
const REST_RATE = 0.005

/** Frame-rate independent approach of `rate` to `target`: slower when speeding up than when slowing down. */
function ease(rate: number, target: number, dt: number): number {
  const slowing = target * rate < 0 || Math.abs(target) < Math.abs(rate)
  const next = rate + (target - rate) * (1 - Math.exp(-dt / (slowing ? PAD_LOOK.easeOut : PAD_LOOK.easeIn)))
  return target === 0 && Math.abs(next) < REST_RATE ? 0 : next
}
