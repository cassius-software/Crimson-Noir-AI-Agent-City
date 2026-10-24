// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the Supplier stage of the SIPOC X flow: keyboard, mouse (pointer-locked,
 * or dragged with the button held), gamepads and touch controls, merged into one per-frame intent — the
 * head's yaw and pitch, held keys, an Analog frame (sticks, triggers, touch stick) and edge-triggered
 * actions (enter/exit vehicle, reset, clock, ghost view, a ping) — plus the hardware bus (HalBus) and the adaptive-trigger hook
 * that turns brake pressure into trigger resistance. With more than one local player (setPlayers) it also keeps the
 * seating plan (seats.ts): the pads are read once a frame and dealt to seats, player 1 keeps the keyboard, the mouse,
 * touch and the pad in seat 0, and every other seat is its own PadSeat intent (intent(seat)).
 * What breaks if it is removed? The player cannot move, look, drive or interact.
 */
import { HalBus } from './hal.ts'
import { createAnalog, isUsablePad, PAD_EDGE, PadLook, PadMapper, type Analog, type PadFamily } from './gamepad.ts'
import { KEYBOARD_SEAT, PadSeat, SEATS, SeatTable, type PlayerIntent, type Seat } from './seats.ts'
import type { GamepadLike } from './web-hardware.d.ts'

export type { Analog, PadFamily } from './gamepad.ts'

export type Action = 'interact' | 'reset' | 'timeForward' | 'timeBack' | 'ghost' | 'matrix' | 'ping'

/** Hold-type touch buttons. `run` is a toggle on the touch layout, but the state lives here. */
export type TouchButton = 'brake' | 'handbrake' | 'run'

/** Max |pitch| of the head, rad (85°): a little short of straight up or down, where yaw would spin. */
export const PITCH_LIMIT = (85 * Math.PI) / 180

export const clampPitch = (p: number): number => (p > PITCH_LIMIT ? PITCH_LIMIT : p < -PITCH_LIMIT ? -PITCH_LIMIT : p)

const ACTION_KEYS: Record<string, Action> = {
  KeyE: 'interact',
  KeyR: 'reset',
  BracketRight: 'timeForward',
  BracketLeft: 'timeBack',
  KeyG: 'ghost',
  /** Matrix mode (01_Initialize_World/matrixMode.ts): falling code on every surface, people and cars passing through each other. */
  KeyM: 'matrix',
  /** A ping where the head looks (08_Swarm/ping.ts); also the middle mouse button and a pad's right shoulder. */
  KeyQ: 'ping',
}

/** Modifier keys: held alone they are keys like any other (Shift runs); with Command they start no chord. */
const MODIFIER_CODES: ReadonlySet<string> = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'])

/** First-person look sensitivities. Look right = yaw down, look up = pitch up. */
export const LOOK = {
  /** rad per mouse count (pointer lock) or CSS pixel (dragging without it) */
  mouse: 0.0022,
  /** rad per CSS pixel of touch drag: a thumb swipe across the right half turns the head about 90°. */
  touchYaw: 0.0052,
  touchPitch: 0.0042,
  /** A press that travels at most this many CSS pixels before release is a click (it captures the pointer). */
  clickSlop: 6,
  /**
   * Mouse counts in one event (|x| + |y|) past which a jump far faster than the mouse was moving is a driver spike, not
   * a look (the spike filter judges counts per millisecond, so a busy frame's merged movement is never one).
   */
  spike: 400,
  /** Milliseconds without a move, over at least two frames, after which the mouse was at rest. */
  rest: 50,
  /** Counts per millisecond past which a jump out of rest (over `spike` counts) is a driver's spike: a hand starting a
   *  turn is slower, even a fast one's first frame, and a long frame's merged move is as slow as the hand. */
  spikeFromRest: 16,
} as const

/** Typing in the terminal (or any field) must never drive the car. */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || typeof t !== 'object') return false
  const el = t as { isContentEditable?: boolean; tagName?: unknown }
  if (el.isContentEditable) return true
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

const errorName = (e: unknown): string => (typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '')

/** The page itself (nothing focused): Space and the arrows have no default there to stop, so the Concierge reads them. */
function isPage(t: EventTarget | null): boolean {
  const tag = (t as { tagName?: unknown } | null)?.tagName
  return typeof tag !== 'string' || ['BODY', 'HTML', 'CANVAS'].includes(tag.toUpperCase())
}

/** The event's time, or now for one that carries none (a synthetic event). */
const stamp = (e: Event): number => (Number.isFinite(e.timeStamp) && e.timeStamp > 0 ? e.timeStamp : performance.now())

function coarsePointer(): MediaQueryList | null {
  try { return typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null } catch { return null }
}

export class Input {
  /** Head yaw, rad (unwrapped): forward = (−sin yaw, −cos yaw) in (x, z). */
  yaw = 0
  /** Head pitch, rad, within ±PITCH_LIMIT; a glance a little below the horizon to start. */
  pitch = -0.05
  locked = false
  /** performance.now() of the last look input (mouse, drag, right stick, touch drag). */
  lastLook = -1e9
  /** Merged gamepad + touch, refreshed by poll(). moveY > 0 = forward, steer > 0 = left. */
  readonly analog: Analog = createAnalog()
  readonly hal: HalBus
  /** Touch controls are shown: a coarse-pointer touch device, or any touch since the mouse last moved. */
  touch = false
  /** Terminal open: keyboard and mouse are ignored. */
  suspended = false
  /** A city action waits for the operator's OK (07_Execute_Actions/ActCard.tsx): the pad's edges and the touch taps are the card's. */
  shielded = false
  private touchEngaged = false
  private lastSource: 'keyboard+mouse' | 'gamepad' | 'touch' = 'keyboard+mouse'
  private readonly keys = new Set<string>()
  private readonly queued = new Set<Action>()
  private readonly disposers: (() => void)[] = []
  private readonly canvas: HTMLCanvasElement
  private readonly mapper = new PadMapper()
  private readonly padLook = new PadLook()
  private readonly lookStep = { yaw: 0, pitch: 0 }
  private readonly pad: Analog = createAnalog()
  private readonly stick = { x: 0, y: 0 }
  private readonly held: Record<TouchButton, boolean> = { brake: false, handbrake: false, run: false }
  /** The primary mouse button is down on the canvas without pointer lock: moving it turns the head. */
  private drag: { id: number; x: number; y: number; travel: number } | null = null
  /** Rate (|x| + |y| counts per ms) and time of the last locked mouse movement, for the spike filter (−1: none yet). */
  private lastRate = 0
  private lastMoveAt = -1
  /** Frames polled since the last locked mouse movement: two or more (and LOOK.rest ms) and the mouse was at rest, not
   *  held up. */
  private pollsSinceMove = 0
  /** When the last frame polled (the clock events are stamped on), so a move out of rest is timed over its own frame. */
  private lastPollAt = -1
  /** The page's clock in milliseconds, as events are stamped (performance.now()). */
  private readonly now: () => number
  /**
   * A pointer press is under way: the focus it brings is the pointer's (focusin). From pointerdown until the click that
   * ends it (a finger's tap focuses only after it lifts), a Tab, or the window losing focus; other keys, a held key's
   * repeats included, leave it.
   */
  private pointerLast = false
  /**
   * The control a pointer press focused. Space would press it again and an arrow scroll its panel, so for it those keys
   * are the game's. One reached with Tab keeps Space, the keyboard's way to press it. Decided when the focus moves, not
   * at the key: Chromium counts a key as keyboard use (:focus-visible) before the key's own event is handled.
   */
  private pointerFocus: EventTarget | null = null
  /** The primary pointer is coarse (a phone, a tablet's finger): the touch overlay stays whatever else moves. */
  private readonly coarse: MediaQueryList | null
  /** The seating plan (seats.ts): one seat until setPlayers; pads are dealt to seats only then. */
  readonly seats = new SeatTable()
  /** Seats 1..3's pad-only intents (seats.ts PadSeat), read each poll while the table has more than one seat. */
  private readonly padSeats: readonly PadSeat[] = [new PadSeat(), new PadSeat(), new PadSeat()]
  /** The pads in seat 0 this frame (seated mode), refilled without allocation. */
  private readonly mine: GamepadLike[] = []

  constructor(canvas: HTMLCanvasElement, hal: HalBus = new HalBus(), now: () => number = () => performance.now()) {
    this.canvas = canvas
    this.hal = hal
    this.now = now
    const on = <K extends keyof DocumentEventMap>(target: Document | HTMLElement, type: K, fn: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts)
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts))
    }
    // Capture phase: these see every press and focus before any handler can stop them.
    on(document, 'pointerdown', (e) => {
      this.pointerLast = true
      // A press on the control that already has the focus moves no focus, so no focusin follows: it is the pointer's.
      const active = document.activeElement
      if (active && (active === e.target || active.contains(e.target as Node))) this.pointerFocus = active
    }, { capture: true })
    on(document, 'click', () => { this.pointerLast = false }, { capture: true })
    // Focus coming back to the control that had it (the window or tab regained) keeps what it was.
    on(document, 'focusin', (e) => { if (e.target !== this.pointerFocus) this.pointerFocus = this.pointerLast ? e.target : null }, { capture: true })
    on(document, 'keydown', (e) => {
      const target = e.target
      if (e.code === 'Tab') this.pointerLast = false
      if (this.suspended || isEditableTarget(target)) return
      // A Command chord (Cmd+A, Cmd+Tab) is the system's: macOS sends no keyup for its letter, which would stay held.
      if (e.metaKey && !MODIFIER_CODES.has(e.code)) return
      this.keys.add(e.code)
      this.lastSource = 'keyboard+mouse'
      const action = ACTION_KEYS[e.code]
      if (action && !e.repeat) this.queued.add(action)
      // Space is the handbrake and the arrows walk: under pointer lock, and over a control a pointer press left focused
      // (pointerFocus), they never click it again or scroll its panel.
      if ((e.code === 'Space' || e.code.startsWith('Arrow')) && (this.locked || (target === this.pointerFocus && !isPage(target)))) e.preventDefault()
    })
    // Always honoured: a key pressed before focus moved into a field must still release. Command coming up drops
    // every held key, since macOS swallows the keyup of any key released while it was down (held keys repeat back).
    on(document, 'keyup', (e) => {
      if (e.code === 'MetaLeft' || e.code === 'MetaRight') this.keys.clear()
      else this.keys.delete(e.code)
    })
    // The canvas's right-click is a look drag's other button, not the browser's menu.
    on(canvas, 'contextmenu', (e) => e.preventDefault())
    on(document, 'mousemove', (e) => {
      if (!this.locked || this.suspended) return
      // Back on the mouse after a controller: the HUD's glyphs follow the hand, not the last button pressed.
      if (e.movementX || e.movementY) this.lastSource = 'keyboard+mouse'
      // Without raw input, Chromium on Windows reports the odd jump of hundreds of counts out of nowhere (the first
      // move after the lock can carry the cursor's trip to the centre): one that size, at more than eight times the
      // rate the mouse was moving, is dropped. Rates, not sizes: a busy frame (a region loading, a pipeline compiling)
      // merges every move it held up into one event, large but no faster, and that is kept, as is a real flick, which
      // ramps up over a few events. While the mouse keeps moving, the event after a dropped one is judged against the
      // dropped one's rate, so two in a row are never dropped. Out of rest (LOOK.rest ms and two frames with no move;
      // without the frames the page was held up, not the hand) the mouse was moving at zero, so the move is timed over
      // the frame it arrived in (since the last poll, at least one 60 Hz frame) and is a spike past
      // LOOK.spikeFromRest: a jump inside an ordinary frame, never a long frame's merged move.
      const size = Math.abs(e.movementX) + Math.abs(e.movementY)
      const at = stamp(e)
      const rested = this.lastMoveAt < 0 || (this.pollsSinceMove >= 2 && at - this.lastMoveAt >= LOOK.rest)
      this.pollsSinceMove = 0
      const rate = rested
        ? size / Math.max(16, this.lastPollAt < 0 ? 0 : at - this.lastPollAt)
        : size / Math.min(1000, Math.max(1, at - this.lastMoveAt))
      const spike = size > LOOK.spike && rate > (rested ? LOOK.spikeFromRest : 8 * this.lastRate + 2.5)
      this.lastRate = Number.isFinite(rate) ? rate : 0
      this.lastMoveAt = at
      if (!spike) this.look(e.movementX, e.movementY, LOOK.mouse, LOOK.mouse)
    })
    // Zero-click look: press and drag turns the head without capturing the pointer; a press released
    // without travelling is a click, and a click captures the pointer for mouse look without a button.
    on(canvas, 'pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.pointerType === 'pen') {
        this.touch = true
        this.engageTouch()
        return
      }
      // The middle button pings (locked or not) and never starts a drag; the browser's autoscroll is declined.
      if (e.button === 1) {
        if (!this.suspended) { this.queued.add('ping'); this.lastSource = 'keyboard+mouse' }
        e.preventDefault()
        return
      }
      if (e.button !== 0 || this.locked || this.suspended) return
      this.lastSource = 'keyboard+mouse'
      this.endDrag()
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, travel: 0 }
      // The drag keeps following the mouse outside the canvas (and the window) until the button is released.
      try { canvas.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
    })
    on(canvas, 'pointermove', (e) => {
      const d = this.drag
      if (!d || d.id !== e.pointerId) return
      // The button came up where no pointerup reached us (another window, a dialog): the drag is over.
      if ((e.buttons & 1) === 0) { this.endDrag(); return }
      const dx = e.clientX - d.x, dy = e.clientY - d.y
      d.x = e.clientX
      d.y = e.clientY
      d.travel += Math.abs(dx) + Math.abs(dy)
      if (!this.locked && !this.suspended) this.look(dx, dy, LOOK.mouse, LOOK.mouse)
    })
    on(canvas, 'pointerup', (e) => {
      const d = this.drag
      if (!d || d.id !== e.pointerId) return
      this.endDrag()
      // Still inside the press's user activation, which pointer lock requires.
      if (d.travel <= LOOK.clickSlop && !this.locked && !this.suspended) this.capturePointer()
    })
    on(canvas, 'pointercancel', (e) => { if (this.drag?.id === e.pointerId) this.endDrag() })
    on(canvas, 'lostpointercapture', (e) => { if (this.drag?.id === e.pointerId) this.drag = null })
    on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas
      this.lastRate = 0
      this.lastMoveAt = -1
      if (this.locked) this.endDrag()
    })
    // Focus or the page lost mid-press: key-ups and pointer-ups may never arrive, so nothing may stay held.
    const onBlur = () => { this.releaseHeld(); this.pointerLast = false }
    window.addEventListener('blur', onBlur)
    this.disposers.push(() => window.removeEventListener('blur', onBlur))
    on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') this.releaseHeld() })

    const coarse = (this.coarse = coarsePointer())
    const hasTouch = () => (typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0) > 0
    this.touch = !!coarse?.matches && hasTouch()
    if (coarse && typeof coarse.addEventListener === 'function') {
      const onChange = () => {
        if (coarse.matches && hasTouch()) this.touch = true
        else this.hideTouch()
      }
      coarse.addEventListener('change', onChange)
      this.disposers.push(() => coarse.removeEventListener('change', onChange))
    }
    // A touch laptop, or a tablet driven by a mouse (a fine primary pointer): the mouse moving again puts the touch
    // overlay away, so its clicks reach the canvas (and capture it) instead of the overlay's look zone, and the Run
    // toggle, whose button goes with it, is let go (Shift runs now). A phone or a tablet whose primary pointer is the
    // finger keeps its overlay whatever else is plugged in (mouseHidesTouch).
    on(document, 'pointermove', (e) => {
      if (!this.touch || e.pointerType !== 'mouse' || !(e.movementX || e.movementY) || !this.mouseHidesTouch) return
      this.hideTouch()
      this.lastSource = 'keyboard+mouse'
    })
    void hal.autoconnect()
  }

  /** The touch overlay goes away, and with it the Run toggle its button latched (Shift runs now). */
  private hideTouch(): void {
    this.touch = false
    this.held.run = false
  }

  /** Turns the head by a pointer movement (same sense as the mouse: right turns right, up looks up). */
  private look(dx: number, dy: number, yawPerPx: number, pitchPerPx: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return
    this.yaw -= dx * yawPerPx
    this.pitch = clampPitch(this.pitch - dy * pitchPerPx)
    this.lastLook = performance.now()
  }

  /**
   * Raw mouse counts where the browser has them (no OS acceleration, none of its spikes); where it refuses the option
   * (NotSupportedError: a platform without raw input), a plain lock, still inside the click's user activation.
   */
  private capturePointer(): void {
    const plain = () => {
      try {
        const lock = this.canvas.requestPointerLock() as unknown
        if (lock instanceof Promise) lock.catch(() => {})
      } catch { /* pointer lock unavailable (embedded, denied, or re-requested too soon after Esc) */ }
    }
    try {
      const lock = this.canvas.requestPointerLock({ unadjustedMovement: true }) as unknown
      if (lock instanceof Promise) lock.catch((e: unknown) => { if (errorName(e) === 'NotSupportedError' && !this.locked) plain() })
    } catch { plain() }
  }

  private endDrag(): void {
    const d = this.drag
    if (!d) return
    this.drag = null
    try { if (this.canvas.hasPointerCapture(d.id)) this.canvas.releasePointerCapture(d.id) } catch { /* already released */ }
  }

  /** Held keys, a mouse drag, the touch stick and the touch brake/handbrake go idle (the run toggle is a latch, not a hold). */
  private releaseHeld(): void {
    this.keys.clear()
    this.endDrag()
    this.padLook.reset()
    for (const seat of this.padSeats) seat.release()
    this.stick.x = 0
    this.stick.y = 0
    this.held.brake = false
    this.held.handbrake = false
  }

  /**
   * The mouse moving puts the touch overlay away: the primary pointer is fine (a touch laptop). On a phone or a tablet
   * whose primary pointer is the finger the overlay stays, so its look zone and stick take a mouse press like a finger
   * (TouchControls.tsx), or the mouse could not look there at all.
   */
  get mouseHidesTouch(): boolean {
    return !this.coarse?.matches
  }

  /** Pointer locked, touch controls engaged, or a gamepad in use. */
  get engaged(): boolean {
    return this.locked || this.touchEngaged || this.mapper.used
  }

  /** The input family used most recently, for the HUD. */
  get device(): 'keyboard+mouse' | 'gamepad' | 'touch' {
    return this.lastSource
  }

  /** Face-button family of the standard pad used most recently (null: none used, or all disconnected). */
  get padFamily(): PadFamily | null {
    return this.mapper.family
  }

  /** The primary mouse button is held on the canvas without pointer lock (drag-look in progress). */
  get dragging(): boolean {
    return this.drag !== null
  }

  down(code: string): boolean {
    return this.keys.has(code)
  }

  /** Edge-triggered: true once per key press. */
  take(action: Action): boolean {
    return this.queued.delete(action)
  }

  /** Programmatic key press, used by the ?debug harness and the touch buttons; nothing while a card waits for the OK. */
  press(action: Action): void {
    if (this.shielded) return
    this.queued.add(action)
  }

  /** Programmatic hold, used by the ?debug harness. */
  hold(code: string, on: boolean): void {
    if (on) this.keys.add(code)
    else this.keys.delete(code)
  }

  /** Terminal open: keyboard and mouse ignored, held keys, drags and queued actions dropped, pointer lock released. */
  suspend(on: boolean): void {
    this.suspended = on
    if (!on) return
    this.keys.clear()
    this.queued.clear()
    this.endDrag()
    this.padLook.reset()
    for (const seat of this.padSeats) seat.release()
    if (document.pointerLockElement === this.canvas) document.exitPointerLock()
  }

  /**
   * A card waits for the operator's OK (its own buttons take the pad and the taps): the pad's edges read in poll() and
   * the touch cluster's press() queue nothing until it lifts, so the south face button presses the card and never the
   * car door. Keys, sticks, triggers, the mouse and the other seats are untouched (E or a walk-off still ends the
   * proposal, in the gateway's words), and the mapper's held bits advance all the while, so no edge replays on lift.
   */
  shield(on: boolean): void {
    this.shielded = on
  }

  /**
   * Seats in play (local split screen): with more than one, the pads are dealt to seats (seats.ts SeatTable: the
   * lowest free seat among 1..n−1 first, then seat 0) and player 1 reads only the pad in seat 0; with one, every pad
   * merges into player 1 as before. Pads in seats that no longer exist stand up at once.
   */
  setPlayers(n: number): void {
    this.seats.setPlayers(n)
    if (this.seats.players <= 1) this.seats.clear()
    for (const seat of this.padSeats) seat.release()
  }

  /** True while the pads are dealt to seats (more than one player). */
  get seated(): boolean {
    return this.seats.players > 1
  }

  /** The intent the frame loop reads for a seat: this (keyboard, mouse, touch and seat 0's pad) for seat 0, the seat's PadSeat otherwise. */
  intent(seat: Seat): PlayerIntent {
    return seat === KEYBOARD_SEAT ? this : this.padSeats[seat - 1]
  }

  /** Face-button family of a seat's pad, for its viewport's glyphs (seat 0: the pad used most recently; null without one). */
  familyOf(seat: number): PadFamily | null {
    if (seat === KEYBOARD_SEAT) return this.padFamily
    return seat > 0 && seat < SEATS ? this.padSeats[seat - 1].padFamily : null
  }

  /** Once per frame, before the engine reads input: gamepads → analog and actions, right stick → head yaw/pitch. */
  poll(dt: number): void {
    if (this.pollsSinceMove < 2) this.pollsSinceMove++
    this.lastPollAt = this.now()
    // Read once: readPads pumps the pads' rumble and syncs their slots; the same list is dealt to every seat.
    const pads = this.hal.readPads()
    let edges: number
    if (this.seats.players > 1) {
      this.seats.assign(pads)
      const mine = this.mine
      mine.length = 0
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i]
        if (isUsablePad(p) && this.seats.seatOf(p.index) === KEYBOARD_SEAT) mine.push(p)
      }
      edges = this.mapper.read(mine, this.pad)
      const now = performance.now()
      for (let s = 1; s < this.seats.players; s++) this.padSeats[s - 1].poll(pads, this.seats, s as Seat, dt, now)
    } else {
      edges = this.mapper.read(pads, this.pad)
    }
    if (this.shielded) edges = 0 // a card waits for the operator's OK: its buttons have the pad (the held bits advanced above)
    if (edges & PAD_EDGE.interact) this.queued.add('interact')
    if (edges & PAD_EDGE.reset) this.queued.add('reset')
    if (edges & PAD_EDGE.timeForward) this.queued.add('timeForward')
    if (edges & PAD_EDGE.timeBack) this.queued.add('timeBack')
    if (edges & PAD_EDGE.ping) this.queued.add('ping')
    if (this.mapper.active) this.lastSource = 'gamepad'

    const a = this.analog, p = this.pad, sx = this.stick.x, sy = this.stick.y
    if (sx * sx + sy * sy > p.moveX * p.moveX + p.moveY * p.moveY) {
      a.moveX = sx; a.moveY = sy; a.steer = -sx
    } else {
      a.moveX = p.moveX; a.moveY = p.moveY; a.steer = p.steer
    }
    a.throttle = Math.max(p.throttle, sy > 0 ? sy : 0)
    a.brake = Math.max(p.brake, sy < 0 ? -sy : 0, this.held.brake ? 1 : 0)
    a.lookX = p.lookX
    a.lookY = p.lookY
    a.run = p.run || this.held.run
    a.handbrake = p.handbrake || this.held.handbrake

    const turn = this.lookStep
    this.padLook.step(a.lookX, a.lookY, dt, turn)
    if (turn.yaw !== 0 || turn.pitch !== 0) {
      this.yaw -= turn.yaw
      this.pitch = clampPitch(this.pitch + turn.pitch)
      if (a.lookX !== 0 || a.lookY !== 0) this.lastLook = performance.now()
    }
  }

  /** Virtual stick, −1..1 per axis (x right, y forward); the vector is clamped to length 1. */
  setTouchStick(x: number, y: number): void {
    const m = Math.hypot(x, y)
    const k = m > 1 ? 1 / m : 1
    this.stick.x = Number.isFinite(x) ? x * k : 0
    this.stick.y = Number.isFinite(y) ? y * k : 0
    if (m > 0) this.engageTouch()
  }

  /** Drag look, in CSS pixels (same sense as mouse movement), at first-person touch sensitivity. */
  touchLook(dx: number, dy: number): void {
    this.look(dx, dy, LOOK.touchYaw, LOOK.touchPitch)
    this.engageTouch()
  }

  engageTouch(): void {
    this.touchEngaged = true
    this.touch = true
    this.lastSource = 'touch'
  }

  setTouchButton(button: TouchButton, on: boolean): void {
    this.held[button] = on
    if (on) this.engageTouch()
  }

  touchHeld(button: TouchButton): boolean {
    return this.held[button]
  }

  dispose(): void {
    for (const d of this.disposers) d()
    this.disposers.length = 0
    this.endDrag()
    for (const seat of this.padSeats) seat.release()
    if (document.pointerLockElement === this.canvas) document.exitPointerLock()
    void this.hal.dispose()
  }
}

/**
 * Adaptive-trigger bridge. `level` is 0..1: 0 = free pull, rising with brake pressure while driving. Changes
 * go to the HAL, which maps them onto the DualSense left-trigger continuous-resistance effect.
 */
export class TriggerFeedback {
  level = 0
  bus: HalBus | null
  private readonly out = { triggerResistance: 0 }

  constructor(bus: HalBus | null = null) {
    this.bus = bus
  }

  set(level: number): void {
    const v = level > 0 ? Math.min(1, level) : 0
    if (Math.abs(v - this.level) < 1e-3) return
    this.level = v
    if (this.bus) {
      this.out.triggerResistance = v
      this.bus.output(this.out)
    }
  }
}
