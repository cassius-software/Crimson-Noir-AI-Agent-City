/**
 * Why does this file exist? It is the Gamepad API driver: it reads W3C "standard"-mapped pads (and the
 * HAL's HID-decoded DualSense, which uses the same shape) into one Analog frame plus edge-triggered
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
 * Which labels a controller carries, by layout (glyphs.ts names each): 'abxy' letters with A at the south
 * button, 'bayx' letters with B there, 'numbered' shoulders and stick clicks (L1 L2 L3) with unlettered face
 * buttons, 'generic' when nobody recognised the pad (every control named by position).
 */
export type PadFamily = 'abxy' | 'bayx' | 'numbered' | 'generic'

/** The layout behind each console maker's USB vendor id (USB-IF assignments; 0x054c is also the DualSense's,
 *  hal.ts). */
export const PAD_VENDOR_LAYOUT: Readonly<Record<number, PadFamily>> = { 0x054c: 'numbered', 0x045e: 'abxy', 0x057e: 'bayx' }

/**
 * A pad's layout from its id: the USB vendor when the browser reports one. Ids without a vendor fall back to what
 * they say: Chromium on Windows marks every XInput pad "(XInput …)" (the letters layout), and the HAL's HID-decoded
 * DualSense is "DualSense (HID)". Anything else is generic: named by position, never mislabelled.
 */
export function padFamilyOf(id: string): PadFamily {
  const vendor = parsePadId(id)?.vendor
  if (vendor !== undefined && PAD_VENDOR_LAYOUT[vendor]) return PAD_VENDOR_LAYOUT[vendor]
  if (/dualsense/i.test(id)) return 'numbered'
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
  private readonly v = { x: 0, y: 0 }
  /** Slot of the pad used most recently, −1 = none. */
  private lastSlot = -1
  private familyId = ''

  /** Fills `out` (zeroed first) and returns PAD_EDGE bits for buttons that went down since the last read. */
  read(pads: ArrayLike<GamepadLike | null | undefined> | null, out: Analog): number {
    zeroAnalog(out)
    this.seen.fill(0)
    let edges = 0, count = 0, any = false, bestMove = 0, bestLook = 0, l3 = false
    let firstPad: GamepadLike | null = null, lastPad: GamepadLike | null = null
    const dz = PAD_TUNING.stickDeadzone, v = this.v
    const n = pads ? pads.length : 0
    for (let i = 0; i < n; i++) {
      const p = pads![i]
      if (!isStandardPad(p)) continue
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
    for (let s = 0; s < SLOTS; s++) if (!this.seen[s]) this.prev[s] = 0
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
