// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the touch layout's rule book and its judge: the sizes the on-screen controls may
 * have (an eight-rung ladder from the 48 px a finger needs, which is Material's 48 dp and more than Apple's 44 pt,
 * up to the stick's zone), the room they must keep from each other and from the screen's edges (24 px at the left
 * and right edges, where a phone's system takes a swipe inward as "back"; the display's own cut-outs come from the
 * browser's safe-area insets on top), and `validateTouchLayout`, which takes the rectangles the overlay actually
 * drew (TouchControls.tsx measures them after every layout) and says whether the layout is valid and, if not, what
 * is wrong, in words. Beside it, PointerOwner is the one rule every held control follows: the pointer that pressed
 * it owns it until that pointer lifts or is taken by the system, and a second finger landing on it is a second finger,
 * never the end of the first, so two thumbs never drop or cancel each other's holds. Pure: no DOM, no React, no clock.
 * What breaks if it is removed? The overlay can only be eyeballed: a control could shrink under a finger, overlap
 * another, or sit in the system's swipe band, and nothing would say so.
 */

/** The rule book. */
export const TOUCH = Object.freeze({
  /** The least a tap or hold target measures on its shorter side, CSS px (Material's 48 dp; Apple asks 44 pt). */
  minTarget: 48,
  /** Apple's minimum, pt (1 pt = 1 CSS px here): named so the check can say which rule a short control fails. */
  appleMinTarget: 44,
  /** Room between two targets, CSS px (Material's 8 dp). */
  gap: 8,
  /** The system's swipe band at the left and right screen edges, CSS px: a hold that drifts into it must not become "back". */
  gestureInset: 24,
  /** The overlay's own inset from the right edge and the bottom, CSS px (the gesture inset at the sides, 16 at the foot). */
  insetX: 24,
  insetY: 16,
  /** The stick zone's inset from the left edge and the bottom, CSS px (its base rests 42 px in). */
  stickInset: 8,
})

/**
 * The eight sizes a control may measure on its shorter side, CSS px: the Menu button and the text pills (48), the
 * handbrake on a short screen (64), the handbrake and the brake on a short screen (72), the round Ping and Run (76),
 * the brake (84), a text pill's least width (88), the stick's base (116) and its zone (184). Every control is one of
 * these, so a size that drifts (a Tailwind class lost, a padding change) is caught, not eyeballed.
 */
export const SIZE_LADDER: readonly number[] = Object.freeze([48, 64, 72, 76, 84, 88, 116, 184])

/** What a control is, for the rules that apply to it. */
export type ControlKind = 'tap' | 'hold' | 'menu' | 'stick' | 'look'

export interface ControlRect {
  readonly name: string
  readonly kind: ControlKind
  /** CSS px from the viewport's top-left. */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface Viewport {
  readonly width: number
  readonly height: number
  /** The browser's safe-area insets (env(safe-area-inset-*)), CSS px; 0 where there are none. */
  readonly safe: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
}

export interface LayoutVerdict {
  readonly valid: boolean
  /** Each rule broken, in words ('' never; one line per problem). */
  readonly problems: readonly string[]
}

/** The viewport with no insets. */
export function viewport(width: number, height: number, safe: Partial<Viewport['safe']> = {}): Viewport {
  return { width, height, safe: { top: safe.top ?? 0, right: safe.right ?? 0, bottom: safe.bottom ?? 0, left: safe.left ?? 0 } }
}

const EPS = 1
const onLadder = (size: number) => SIZE_LADDER.some((s) => Math.abs(s - size) <= EPS)
const overlap = (a: ControlRect, b: ControlRect) => a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS
/** The shortest distance between two rectangles that do not overlap (0 when they touch), CSS px. */
function distance(a: ControlRect, b: ControlRect): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w))
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h))
  return Math.hypot(dx, dy)
}
const finite = (r: ControlRect) => Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h)

/**
 * The stick's base at rest: the middle of its zone (the zone is 184 px, the base 116, so 34 px in on every side). A
 * thumb may land anywhere in the zone, and the base jumps to it, but never nearer the edge than this.
 */
export function stickBase(zone: ControlRect): ControlRect {
  const inset = Math.max(0, (Math.min(zone.w, zone.h) - 116) / 2)
  return { name: `${zone.name} base`, kind: 'stick', x: zone.x + inset, y: zone.y + inset, w: zone.w - 2 * inset, h: zone.h - 2 * inset }
}

/**
 * Judges a drawn layout. The rules, each a line of `problems` when broken:
 * - every control is on screen (within the viewport);
 * - a tap, hold or menu control measures at least TOUCH.minTarget on its shorter side (the line names the rule it
 *   fails: Apple's 44 pt or Material's 48 dp), and the stick's zone at least its base (116);
 * - every control's shorter side is a rung of SIZE_LADDER;
 * - no two controls overlap (the look zone is the background the buttons stand on, so it is left out), and two
 *   targets keep TOUCH.gap between them;
 * - no tap, hold or menu control, and not the stick's base, reaches into the system's swipe band at the left or
 *   right edge (TOUCH.gestureInset past the safe-area inset there), nor under the bottom safe-area inset.
 * Valid when the list is empty. Non-finite rectangles (an element not laid out yet) are a problem, not a crash.
 */
export function validateTouchLayout(controls: readonly ControlRect[], vp: Viewport): LayoutVerdict {
  const problems: string[] = []
  const targets = controls.filter((c) => c.kind !== 'look')
  for (const c of controls) {
    if (!finite(c)) { problems.push(`${c.name}: not laid out`); continue }
    if (c.x < -EPS || c.y < -EPS || c.x + c.w > vp.width + EPS || c.y + c.h > vp.height + EPS) problems.push(`${c.name}: off screen`)
    const short = Math.min(c.w, c.h)
    if (c.kind === 'tap' || c.kind === 'hold' || c.kind === 'menu') {
      if (short < TOUCH.appleMinTarget - EPS) problems.push(`${c.name}: ${Math.round(short)} px, under the 44 pt a finger needs`)
      else if (short < TOUCH.minTarget - EPS) problems.push(`${c.name}: ${Math.round(short)} px, under the 48 dp a finger needs`)
    } else if (c.kind === 'stick' && short < 116 - EPS) problems.push(`${c.name}: ${Math.round(short)} px, smaller than the stick's base`)
    if (c.kind !== 'look' && !onLadder(short)) problems.push(`${c.name}: ${Math.round(short)} px is not a size on the ladder`)
  }
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      const a = targets[i], b = targets[j]
      if (!finite(a) || !finite(b)) continue
      if (overlap(a, b)) problems.push(`${a.name} over ${b.name}`)
      else if (a.kind !== 'stick' && b.kind !== 'stick' && distance(a, b) < TOUCH.gap - EPS) problems.push(`${a.name} and ${b.name}: ${Math.round(distance(a, b))} px apart, under the 8 px gap`)
    }
  }
  const left = vp.safe.left + TOUCH.gestureInset, right = vp.width - vp.safe.right - TOUCH.gestureInset, bottom = vp.height - vp.safe.bottom
  for (const c of targets) {
    if (!finite(c)) continue
    const r = c.kind === 'stick' ? stickBase(c) : c
    if (r.x < left - EPS) problems.push(`${r.name}: in the system's swipe band at the left edge (${Math.round(r.x)} px in, ${left} needed)`)
    if (r.x + r.w > right + EPS) problems.push(`${r.name}: in the system's swipe band at the right edge (${Math.round(vp.width - r.x - r.w)} px in, ${Math.round(vp.width - right)} needed)`)
    if (r.y + r.h > bottom + EPS) problems.push(`${r.name}: under the bottom safe-area inset`)
  }
  return { valid: problems.length === 0, problems }
}

/** The verdict as the overlay's `data-touch-layout` attribute carries it: "valid", or "invalid: " and the problems. */
export function layoutAttribute(v: LayoutVerdict): string {
  return v.valid ? 'valid' : `invalid: ${v.problems.join('; ')}`
}

/**
 * Who holds a control: the first pointer to press it, until that pointer lifts, is cancelled or loses its capture.
 * `claim` says whether a pointer may act on the control (the owner, or anyone while it is free); a second finger is
 * refused, so it can neither press the control again nor, on lifting, release what the first finger holds.
 */
export class PointerOwner {
  private owner = -1

  /** True when `id` owns the control (taking it if it was free). */
  claim(id: number): boolean {
    if (this.owner === -1) this.owner = id
    return this.owner === id
  }

  /** True when `id` owned the control and has now let it go; false for any other pointer (the hold stands). */
  release(id: number): boolean {
    if (this.owner !== id) return false
    this.owner = -1
    return true
  }

  get held(): boolean {
    return this.owner !== -1
  }

  get id(): number {
    return this.owner
  }

  /** Lets go whoever holds it (a remount, focus lost). */
  clear(): void {
    this.owner = -1
  }
}
