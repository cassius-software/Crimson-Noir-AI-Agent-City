// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the seating plan for up to four players at one screen: which hardware drives
 * which player. Seat 0 is the keyboard, the mouse and the touch overlay (player 1); gamepads take seats by
 * their slot — a pad that appears joins the lowest free seat among 1..3, or seat 0 when every other seat is
 * taken (or the table has only that seat) and no pad sits there yet; a pad that disappears frees its seat at
 * once; a seated pad keeps its seat however the pad list is ordered and whatever other pads do. The table is
 * pure and deterministic (pads are considered by index, never by their position in the list, so the HAL's
 * HID-decoded pads at index 16+ seat like any other). Beside it, PadSeat is one player's merged intent from
 * a gamepad alone: its own button edges, analog frame and eased right-stick head motion, the same mapping
 * Input gives player 1, so the frame loop can read every seat through one interface (PlayerIntent).
 * What breaks if it is removed? A second, third or fourth player has no way to be told apart from the first:
 * every pad would merge into one body again.
 */
import { clampPitch, type Action } from './input.ts'
import { createAnalog, isUsablePad, PAD_EDGE, PadLook, PadMapper, type Analog, type PadFamily, type GenericLayout } from './gamepad.ts'
import type { GamepadLike } from './web-hardware.d.ts'

/** Seats at the table: player 1 at seat 0. */
export const SEATS = 4
export type Seat = 0 | 1 | 2 | 3
/** How many players a table may be set for, inclusive: one (today's game) to every seat. */
export const SEATS_RANGE: readonly [number, number] = Object.freeze([1, SEATS] as [number, number])
/** The seat the keyboard, the mouse and the touch overlay belong to. */
export const KEYBOARD_SEAT: Seat = 0

/** A player count within SEATS_RANGE: a fractional request rounds down, one beyond the range saturates, NaN is one. */
export function clampPlayers(n: number): number {
  if (Number.isNaN(n)) return SEATS_RANGE[0]
  const i = Math.floor(n)
  return i < SEATS_RANGE[0] ? SEATS_RANGE[0] : i > SEATS_RANGE[1] ? SEATS_RANGE[1] : i
}

/**
 * The read surface of one player's merged intent, as the frame loop reads it: the head angles, the analog
 * frame, held keys and edge-triggered actions. Input (player 1) satisfies it as it is; PadSeat is a pad-only one.
 */
export interface PlayerIntent {
  /** Head yaw, rad (unwrapped): forward = (−sin yaw, −cos yaw) in (x, z). */
  yaw: number
  /** Head pitch, rad, within ±PITCH_LIMIT. */
  pitch: number
  /** The clock reading of the last look input (the caller's clock, performance.now() on the page). */
  lastLook: number
  readonly analog: Analog
  down(code: string): boolean
  take(action: Action): boolean
  press(action: Action): void
}

/** Turns PadMapper's edge bits into queued actions: one table for player 1's Input and every PadSeat. */
export function queueEdges(edges: number, queued: Set<Action>): void {
  if (edges & PAD_EDGE.interact) queued.add('interact')
  if (edges & PAD_EDGE.reset) queued.add('reset')
  if (edges & PAD_EDGE.timeForward) queued.add('timeForward')
  if (edges & PAD_EDGE.timeBack) queued.add('timeBack')
}

type PadList = ArrayLike<GamepadLike | null | undefined> | null | undefined

/** The usable pad (isUsablePad) with the lowest index in `pads` above `after` (−1 none). Duplicated indices count once. */
function nextPadIndex(pads: PadList, after: number): number {
  let best = -1
  const n = pads ? pads.length : 0
  for (let i = 0; i < n; i++) {
    const p = pads![i]
    if (!isUsablePad(p) || p.index <= after) continue
    if (best < 0 || p.index < best) best = p.index
  }
  return best
}

function hasPad(pads: PadList, index: number): boolean {
  const n = pads ? pads.length : 0
  for (let i = 0; i < n; i++) {
    const p = pads![i]
    if (isUsablePad(p) && p.index === index) return true
  }
  return false
}

/**
 * Which pad sits in which seat. `assign` is called once per frame with the pads the HAL read; it allocates
 * nothing. One pad per seat, one seat per pad (by `pad.index`); pads beyond the free seats stay unseated
 * (`seatOf` −1) until a seat frees, and then join in index order.
 */
export class SeatTable {
  /** Seats in play, within SEATS_RANGE: seat 0 always, pads fill seats 1..players−1 first. */
  private players_: number
  /** seat → pad index, −1 = no pad. */
  private readonly padOf = new Int32Array(SEATS).fill(-1)

  constructor(players: number = SEATS_RANGE[0]) {
    this.players_ = clampPlayers(players)
  }

  get players(): number {
    return this.players_
  }

  /** Changes the number of seats in play; a pad in a seat that no longer exists is unseated at once. */
  setPlayers(n: number): void {
    const p = clampPlayers(n)
    this.players_ = p
    for (let s = p; s < SEATS; s++) this.padOf[s] = -1
  }

  /** Pads with a seat. */
  get count(): number {
    let c = 0
    for (let s = 0; s < SEATS; s++) if (this.padOf[s] >= 0) c++
    return c
  }

  /** The seat of the pad with this index, −1 when it has none. */
  seatOf(padIndex: number): Seat | -1 {
    if (padIndex < 0) return -1
    for (let s = 0; s < SEATS; s++) if (this.padOf[s] === padIndex) return s as Seat
    return -1
  }

  /** The index of the pad in this seat, −1 when none sits there. */
  padIndexOf(seat: number): number {
    return seat >= 0 && seat < SEATS ? this.padOf[seat] : -1
  }

  /** True when the seat is in play (seat 0 always; a pad's seat only while it holds a pad). */
  occupied(seat: number): boolean {
    return seat === KEYBOARD_SEAT ? true : this.padIndexOf(seat) >= 0
  }

  /** Everyone stands up (the pads will re-seat on the next assign, in index order). */
  clear(): void {
    this.padOf.fill(-1)
  }

  /**
   * Frees the seats of pads no longer listed, then seats unseated pads in index order: the lowest free seat
   * among 1..players−1, then seat 0 when it holds no pad. Returns true when any seat changed hands.
   */
  assign(pads: PadList): boolean {
    let changed = false
    const seat = this.padOf
    for (let s = 0; s < SEATS; s++) {
      if (seat[s] >= 0 && !hasPad(pads, seat[s])) { seat[s] = -1; changed = true }
    }
    let after = -1
    for (;;) {
      const index = nextPadIndex(pads, after)
      if (index < 0) break
      after = index
      if (this.seatOf(index) >= 0) continue
      const free = this.freeSeat()
      if (free < 0) break
      seat[free] = index
      changed = true
    }
    return changed
  }

  /** The seat a joining pad takes: 1..players−1 lowest first, then seat 0; −1 when the table is full. */
  private freeSeat(): number {
    for (let s = 1; s < this.players_; s++) if (this.padOf[s] < 0) return s
    return this.padOf[KEYBOARD_SEAT] < 0 ? KEYBOARD_SEAT : -1
  }
}

/**
 * One player's intent from a gamepad alone (seats 1..3, or seat 0's pad when player 1's Input does not merge
 * it): the same mapping as Input.poll for pads, with its own edge state, run latch and eased head motion.
 * Pure: no DOM, no clock of its own — `poll` is told the time.
 */
export class PadSeat implements PlayerIntent {
  yaw = 0
  /** A glance a little below the horizon to start, like Input. */
  pitch = -0.05
  lastLook = -1e9
  readonly analog: Analog = createAnalog()
  private readonly mapper = new PadMapper()

  /** The layout this seat's mapper settled on for a pad read by position (gamepad.ts GenericPads.layoutOf). */
  layoutOf(index: number): GenericLayout | null {
    return this.mapper.generic.layoutOf(index)
  }
  private readonly padLook = new PadLook()
  private readonly lookStep = { yaw: 0, pitch: 0 }
  private readonly queued = new Set<Action>()
  /** The pads of this seat this frame, refilled without allocation. */
  private readonly mine: GamepadLike[] = []

  /** A pad produced input during the last poll. */
  get active(): boolean {
    return this.mapper.active
  }

  /** A pad has produced input since it was seated. */
  get used(): boolean {
    return this.mapper.used
  }

  /** Face-button family of this seat's pad, for its viewport's glyphs (null before any input). */
  get padFamily(): PadFamily | null {
    return this.mapper.family
  }

  /** A pad has no keys. */
  down(_code: string): boolean {
    return false
  }

  /** Edge-triggered: true once per press. */
  take(action: Action): boolean {
    return this.queued.delete(action)
  }

  press(action: Action): void {
    this.queued.add(action)
  }

  /**
   * Once per frame: the pads in `seat` of `table` → this seat's analog frame and actions, the right stick →
   * head yaw/pitch (clamped). `dt` in seconds, `now` the caller's clock for lastLook.
   */
  poll(pads: PadList, table: SeatTable, seat: Seat, dt: number, now: number): void {
    const mine = this.mine
    mine.length = 0
    const n = pads ? pads.length : 0
    for (let i = 0; i < n; i++) {
      const p = pads![i]
      if (isUsablePad(p) && table.seatOf(p.index) === seat) mine.push(p)
    }
    const a = this.analog
    queueEdges(this.mapper.read(mine, a), this.queued)
    const turn = this.lookStep
    this.padLook.step(a.lookX, a.lookY, dt, turn)
    if (turn.yaw !== 0 || turn.pitch !== 0) {
      this.yaw -= turn.yaw
      this.pitch = clampPitch(this.pitch + turn.pitch)
      if (a.lookX !== 0 || a.lookY !== 0) this.lastLook = now
    }
  }

  /** Focus lost or the console opened: the head stops and queued presses are dropped (mirrors Input.suspend). */
  release(): void {
    this.padLook.reset()
    this.queued.clear()
  }
}
