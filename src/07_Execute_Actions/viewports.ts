// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the arithmetic of local split screen: how one canvas is cut into one to four
 * viewports in logical pixels (full; side by side in landscape or stacked in portrait; one wide top and two below;
 * quadrants), with integer edges that tile the canvas exactly so no pixel is drawn twice or left over; the aspect of
 * each; the y flip for a renderer whose viewport origin is the bottom-left corner; who looks out of viewports 2–4
 * (the camera is only ever a head, and there is one avatar in the physics realm, so the other players spectate
 * through a pedestrian's eyes: a tethered recruit first, else a stable hashed pick, never the player's own row); and
 * the spare gamepad's right stick as a look offset on that walker's heading (the same curve, rates and pitch limit
 * as the first player's stick, allocation-free, so a spare pad feels like the main one). Pure: no renderer, no DOM,
 * no clock, no worker; the engine applies the rects and poses the heads.
 * What breaks if it is removed? Viewports would be cut by hand in the engine, off by a pixel at odd sizes, seams
 * would smear between quadrants, a spectator could land on row 0 and look out of the player's own head, and a spare
 * pad could pitch a head past straight up.
 */
import { PAD_TUNING, PadLook, radialDeadzone } from '../04_Connect_Hardware/gamepad.ts'
import { clampPitch } from '../04_Connect_Hardware/input.ts'

/** Inclusive range of local players one canvas can hold: one full view up to four quadrants. */
export const PLAYERS_RANGE: readonly [number, number] = Object.freeze([1, 4] as [number, number])

/**
 * The player count a URL or console asked for, clamped into PLAYERS_RANGE: a number or numeric string rounds down
 * to an integer; anything else (null, '', 'four', NaN, Infinity) is one player.
 */
export function clampPlayers(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(n)) return PLAYERS_RANGE[0]
  const i = Math.floor(n)
  return i < PLAYERS_RANGE[0] ? PLAYERS_RANGE[0] : i > PLAYERS_RANGE[1] ? PLAYERS_RANGE[1] : i
}

/** One viewport in logical (CSS) pixels; `y` grows downward from the canvas's top edge unless flipped. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * A canvas edge as an integer pixel count of at least `min` (a collapsed element still gets drawable rects: one
 * pixel for one view, two so that a halved edge keeps a pixel on each side).
 */
const edge = (v: number, min: number = 1): number => (Number.isFinite(v) && v >= min ? Math.floor(v) : min)

/**
 * Cuts a `width` × `height` canvas into `players` rects (count clamped into PLAYERS_RANGE, edges floored to
 * integers, at least one pixel for one player and two for more). The rects are disjoint, have integer edges and no
 * zero-size side, and their union is the whole canvas, including the odd pixel when a side does not halve: the first
 * half gets floor(n / 2), the second the rest. One: the full canvas. Two: side by side when the canvas is landscape
 * (or square), stacked when portrait. Three: one wide view across the top, two below it. Four: quadrants, reading
 * order. Index 0 is always the first player's view, at the top-left corner.
 */
export function splitScreen(players: number, width: number, height: number): Rect[] {
  const n = clampPlayers(players)
  const min = n > 1 ? 2 : 1
  const w = edge(width, min), h = edge(height, min)
  const wl = Math.floor(w / 2), wr = w - wl
  const ht = Math.floor(h / 2), hb = h - ht
  if (n === 1) return [{ x: 0, y: 0, width: w, height: h }]
  if (n === 2) {
    return w >= h
      ? [{ x: 0, y: 0, width: wl, height: h }, { x: wl, y: 0, width: wr, height: h }]
      : [{ x: 0, y: 0, width: w, height: ht }, { x: 0, y: ht, width: w, height: hb }]
  }
  if (n === 3) {
    return [
      { x: 0, y: 0, width: w, height: ht },
      { x: 0, y: ht, width: wl, height: hb },
      { x: wl, y: ht, width: wr, height: hb },
    ]
  }
  return [
    { x: 0, y: 0, width: wl, height: ht },
    { x: wl, y: 0, width: wr, height: ht },
    { x: 0, y: ht, width: wl, height: hb },
    { x: wl, y: ht, width: wr, height: hb },
  ]
}

/** Width over height of a rect, for the camera that draws it; a degenerate rect reads as square. */
export function aspectOf(rect: Rect): number {
  const a = rect.width / rect.height
  return Number.isFinite(a) && a > 0 ? a : 1
}

/**
 * The same rect for a renderer whose viewport origin is the canvas's bottom-left corner: when `flip` is true the y
 * is measured up from the bottom edge of a `height`-pixel canvas; when false the rect comes back unchanged (the
 * backend's own origin is already the top-left). Which the WebGPU backend uses is verified in a browser, not here;
 * the flag keeps the arithmetic honest either way. The result still tiles the canvas exactly.
 */
export function originBottomLeft(rect: Rect, height: number, flip: boolean): Rect {
  if (!flip) return rect
  return { x: rect.x, y: edge(height) - rect.y - rect.height, width: rect.width, height: rect.height }
}

/** Who a spectating viewport may look through: the shape simProtocol's RecruitView already has. */
export interface SpectatorCandidate {
  readonly agent: number
  readonly state: 'Interviewing' | 'Active'
}

/** No one to look through (fewer than two pedestrian rows): the engine keeps that viewport on the first player's head. */
export const NO_SPECTATOR = -1

/**
 * The pedestrian row viewport `k` (1 for the second player, up to 3) looks through, among `agents` crowd rows. Row 0
 * is the player's own body and is never chosen. Tethered recruits come first, Active before Interviewing, each in
 * list order and each once, so the second player sees through the first recruit's eyes, the third through the
 * second's; when the recruits run out the rest are a stable hashed pick over the remaining rows, so the same k with
 * the same crowd and the same tethers always gives the same person and no two viewports share one. NO_SPECTATOR
 * when there is no row but the player's own.
 */
export function spectatorFor(k: number, agents: number, recruits: readonly SpectatorCandidate[]): number {
  const rows = Number.isFinite(agents) ? Math.floor(agents) : 0
  if (rows < 2) return NO_SPECTATOR
  const slot = Number.isFinite(k) ? Math.max(1, Math.floor(k)) : 1
  const taken: number[] = []
  const valid = (a: number): boolean => Number.isInteger(a) && a > 0 && a < rows && !taken.includes(a)
  for (const state of ['Active', 'Interviewing'] as const) {
    for (const r of recruits) {
      if (r.state !== state || !valid(r.agent)) continue
      taken.push(r.agent)
      if (taken.length === slot) return r.agent
    }
  }
  // Hashed picks for the viewports the tethers did not fill, each skipping forward past rows already taken, until
  // every pedestrian row is held; more viewports than pedestrians then share them in turn (row 0 still refused).
  for (let i = taken.length; i < slot && taken.length < rows - 1; i++) {
    let a = 1 + (hash(i + 1, rows) % (rows - 1))
    while (!valid(a)) a = a + 1 < rows ? a + 1 : 1
    taken.push(a)
  }
  return taken[(slot - 1) % taken.length]
}

/** A small integer mix of the viewport number and the crowd size, so the pick changes with neither frame nor clock. */
function hash(k: number, rows: number): number {
  let x = (Math.imul(k, 0x9e3779b1) ^ Math.imul(rows, 0x85ebca77)) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 0x2c1b3c6d) >>> 0
  x ^= x >>> 12
  return x >>> 0
}

/**
 * A spare pad's look offset on the spectated walker's heading: yaw and pitch in radians, plus the scratch the mapper
 * writes into so a frame allocates nothing. Yaw grows to the left like the first player's head (look right = yaw
 * down); pitch is kept within the head's limit.
 */
export interface LookState {
  yaw: number
  pitch: number
  readonly rates: PadLook
  readonly stick: { x: number; y: number }
  readonly turn: { yaw: number; pitch: number }
}

export function createLookState(): LookState {
  return { yaw: 0, pitch: 0, rates: new PadLook(), stick: { x: 0, y: 0 }, turn: { yaw: 0, pitch: 0 } }
}

/** The right stick's raw axes in a standard-mapping gamepad's `axes` array. */
export const LOOK_AXES = { x: 2, y: 3 } as const

/**
 * Advances `state` by `dt` seconds from a spare gamepad's raw `axes` (navigator.getGamepads()[slot].axes; a short
 * or broken array reads as centred): the right stick through the same radial dead zone and quadratic curve as the
 * first player's pad, the same eased rates (PadLook), yaw accumulated unwrapped, pitch clamped. Returns `state`
 * itself; nothing is allocated.
 */
export function padLook(axes: ArrayLike<number> | null | undefined, dt: number, state: LookState): LookState {
  const ax = axes ? axes[LOOK_AXES.x] : 0, ay = axes ? axes[LOOK_AXES.y] : 0
  const v = state.stick
  radialDeadzone(ax ?? 0, ay ?? 0, PAD_TUNING.stickDeadzone, v)
  const m = Math.hypot(v.x, v.y)
  const turn = state.turn
  state.rates.step(v.x * m, -v.y * m, dt, turn)
  state.yaw -= turn.yaw
  state.pitch = clampPitch(state.pitch + turn.pitch)
  return state
}

/** Stops the head at once (focus lost, the pad unplugged) and forgets the offset. */
export function resetLook(state: LookState): LookState {
  state.rates.reset()
  state.yaw = 0
  state.pitch = 0
  state.turn.yaw = 0
  state.turn.pitch = 0
  state.stick.x = 0
  state.stick.y = 0
  return state
}
