// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the furnishing view's state and every edit, without the page (HomeCard.tsx draws it
 * and feeds it the keys, the pad, the pointers and the buttons): one visit to a home its owner furnishes (Visit), the
 * words it says (the plan's verdict words and each furniture line's short name), the left stick's repeat (stickStep)
 * and how a card button got the focus (FocusOrigin). Kept apart from the card's markup so Node runs it as the page does
 * (furnishVisit.test.ts): a piece picked up goes back where it was, a press on no cell does nothing, a held diagonal
 * repeats on the plan's timer, and Enter places after a mouse click on a button.
 * Every committed edit (a piece placed, picked up, moved, removed, a finish, Clear, Undo) goes to the host as the whole
 * record (homeStore.ts withHome and layoutOf: the placed pieces first, then those not placed here). A piece picked up
 * leaves the home until it is placed again; Undo, switching line or closing the card puts it back at its place in the
 * saved order, so the home is drawn as it was before. Undo takes back 20 edits.
 * What breaks if it is removed? The card has nothing to furnish with: no cursor, no piece in hand, no edit, no Undo.
 */
import { DEPTH, GRID } from '../02_Define_The_Rules/homeGrid.ts'
import {
  FLOORS, SHAPE_IDS, WALLS, canPlace, cellIndex, fitLayout, pieceCells, shapeOf, type Piece, type Verdict,
} from '../02_Define_The_Rules/homeLayout.ts'
import { finishOf, layoutOf, withHome, type HomeLayout, type HomeRecord } from '../05_Observe_Environment/homeStore.ts'
import type { Draft } from './homeView.ts'
import type { Shopkeeper } from './shopkeeper.ts'
import { GATE, itemById } from './storeCatalog.ts'

/**
 * What the card needs of the engine to furnish a home (App builds it over engine.ts): why furnishing is refused now
 * (furnishRefusal, null when it is allowed), the ask to begin (setHomeCard with furnish), the draft it draws and poses
 * the camera from (setHomeDraft), the cells someone stands on (blockedCells), the cell under a point of the city's
 * canvas (pickCell), and that canvas itself.
 */
export interface FurnishHooks {
  refusal(home: number): string | null
  begin(home: number): void
  setDraft(draft: Draft | null): void
  blocked(home: number): Uint8Array
  pickCell(clientX: number, clientY: number): { c: number; r: number } | null
  canvas(): HTMLCanvasElement | null
}

/** The furnishing view's tabs, in order: 1, 2 and 3 on the keyboard, the pad's triggers step through them. */
export const TABS = Object.freeze(['Furniture', 'Floor', 'Walls'] as const)

/** How many committed edits Undo can take back in one visit. */
export const UNDO_STEPS = 20

/**
 * The left stick moves the cursor once past `dead`, again after `first` ms and then every `repeat` ms while held. Near
 * a diagonal it keeps its direction until the other axis leads by `turn`, so the stick's own noise never turns it.
 */
export const STICK = Object.freeze({ dead: 0.5, first: 300, repeat: 120, turn: 0.15 })

/** What canPlace's verdicts say under the plan (N: the line's cap in one home). */
const VERDICT_WORDS: Readonly<Record<Verdict, string>> = Object.freeze({
  ok: 'Fits',
  outside: 'Outside the room',
  overlap: 'Something is already there',
  doorway: 'Keeps the doorway clear',
  wall: 'Goes against a wall',
  copies: 'N of these is the most for one home',
  full: '16 pieces is the most a home holds',
  you: 'You are standing there',
  sealed: 'Would cut off part of the room',
  seat: 'Would block a workstation\'s seat',
  unowned: 'Not yours yet: Order it',
})

/** Each furniture line's short name on the plan, the strip and the reason line; its first letter is its initial on the plan. */
const SHORT: Readonly<Record<number, string>> = Object.freeze({
  160: 'Desk',
  161: 'Console',
  162: 'Holo table',
  163: 'Sofa',
  164: 'Bookcase',
  165: 'Espresso bar',
  166: 'Piano',
  167: 'Green wall',
  168: 'Workstation',
})

export const nameOf = (id: number): string => SHORT[id] ?? itemById(id)?.name ?? `line ${id}`
export const verdictWords = (v: Verdict, id: number): string => VERDICT_WORDS[v].replace(/^N\b/, String(shapeOf(id)?.cap ?? ''))
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
/** Where the cursor is, in words: columns from the left as seen from the doorway, rows from the home's back wall, from 1. */
export const placeWords = (home: number, at: { c: number; r: number }): string => `column ${at.c + 1}, row ${at.r - (GRID - DEPTH[home]) + 1}`

/** One thing the keys, the pad, a pointer or a button asks of the furnishing view. */
export type Act =
  | 'place' | 'rotate' | 'remove' | 'undo' | 'prev' | 'next' | 'view' | 'unview' | 'tabPrev' | 'tabNext' | 'clear' | 'close'
  | { move: readonly [number, number] }
  | { tab: number }
  | { to: { c: number; r: number } }
  | { press: { c: number; r: number } | null }
  | { removeAt: { c: number; r: number } | null }
  | { wheel: number }
  | { pick: number }
  | { order: number }
  | { floor: number }
  | { wall: number }

/**
 * One step Undo takes back: the home's layout before an edit, the piece then picked up and its place in the saved
 * order, and the turn then in hand.
 */
interface Step { layout: HomeLayout | null; lifted: Piece | null; at: number; rot: number }

/** What a visit reaches the page through: this render's shopkeeper, host and engine hooks, and the redraw. */
export interface VisitIo {
  keeper: Pick<Shopkeeper, 'owns' | 'buy'>
  onRecord: (next: HomeRecord) => void
  hooks: FurnishHooks
  onClose: () => void
  changed: () => void
}

/** The cells a table marks as a key (which ones, in order): a change in who stands where redraws the plan. */
function cellsKey(cells: ArrayLike<number>): string {
  let key = ''
  for (let i = 0; i < cells.length; i++) if (cells[i]) key += `${i},`
  return key
}

/**
 * One visit's furnishing: its state and every edit, in one place the keys, the pad's loop, a pointer and the buttons
 * all read and change (so none of them ever acts on a stale copy); each change asks for a redraw. The record it edits
 * is the one it last committed (or was handed), so two edits in one frame build on each other.
 */
export class Visit {
  readonly home: number
  /** The home's first row (its back wall's): the cursor stays in rows first to GRID − 1. */
  readonly first: number
  io: VisitIo
  tab = 0
  cursor: { c: number; r: number }
  /** The line chosen in the strip (the piece in hand when nothing is picked up), or null. */
  sel: number | null
  rot = 0
  /** A placed piece picked up: out of the home's layout, in hand, put back where it was by Undo, a line chosen or closing. */
  lifted: Piece | null = null
  /**
   * Where the piece picked up stood in the saved order (its index among the placed pieces): put back there, fitLayout
   * gives the layout it gave before the pickup, so a stored piece that fits only while it is out stays stored.
   */
  liftedAt = 0
  view: 0 | 1 | 2 | 3 = 0
  /** What the last press did, in words, until the cursor or the piece changes; then the reason line says the verdict. */
  said = ''
  readonly undoSteps: Step[] = []
  record: HomeRecord
  blocked: Uint8Array
  private blockedKey: string
  private wheelSum = 0
  private wheelAt = 0
  /** The records this visit handed the host: one coming back as a prop is never newer than `record`. */
  private readonly produced = new WeakSet<HomeRecord>()

  constructor(home: number, record: HomeRecord, io: VisitIo) {
    this.home = home
    this.first = GRID - DEPTH[home]
    this.io = io
    this.record = record
    // In hand at first: the first line owned that has room left here, else the first owned, else nothing.
    const placed = this.fit().placed
    const mine = SHAPE_IDS.filter((id) => this.owns(id))
    this.sel = mine.find((id) => placed.filter((p) => p.id === id).length < (shapeOf(id)?.cap ?? 0)) ?? mine[0] ?? null
    this.cursor = { c: GRID / 2 - 1, r: this.first + Math.floor(DEPTH[home] / 2) - 1 }
    this.blocked = io.hooks.blocked(home)
    this.blockedKey = cellsKey(this.blocked)
  }

  /** Whether the player owns line `id`: the shopkeeper's word, read afresh. */
  owns(id: number): boolean {
    return this.io.keeper.owns(id)
  }
  /** The saved layout fitted as the engine draws it (fitLayout with the lines owned): what stands here and what does not. */
  fit(): { placed: Piece[]; stored: Piece[] } {
    return fitLayout(this.home, this.record[this.home]?.pieces ?? [], (id) => this.owns(id))
  }
  /** The piece in hand at the cursor: the one picked up, else the chosen line; null for none. */
  hand(): Piece | null {
    const id = this.lifted ? this.lifted.id : this.sel
    return id === null ? null : Object.freeze({ id, c: this.cursor.c, r: this.cursor.r, rot: this.rot })
  }
  /** Whether the piece in hand may go where it is (canPlace, with who stands where and what is owned); null with nothing in hand. */
  verdict(fit = this.fit()): Verdict | null {
    const h = this.hand()
    return h && canPlace(this.home, fit.placed, h, this.blocked, (id) => this.owns(id))
  }
  /** The placed piece whose footprint covers cell (c, r), or null. */
  pieceAt(placed: readonly Piece[], c: number, r: number): Piece | null {
    const at = cellIndex(c, r)
    return placed.find((p) => pieceCells(p).cells.includes(at)) ?? null
  }
  /** The page this visit reaches: each committed render's shopkeeper, host, hooks and close. */
  connect(io: VisitIo): void {
    this.io = io
  }
  /** A record handed in that this visit did not make (nothing else edits the homes today, but a host may): edits build on it. */
  adopt(record: HomeRecord): void {
    if (record === this.record || this.produced.has(record)) return
    this.record = record
    this.io.changed()
  }

  private say(text: string): void {
    this.said = text
    this.io.changed()
  }
  private quiet(): void {
    this.said = ''
    this.io.changed()
  }
  /** The record with this home's layout replaced, handed to the host (which saves it and redraws the homes). */
  private send(layout: HomeLayout | null): void {
    this.record = withHome(this.record, this.home, layout)
    this.produced.add(this.record)
    this.io.onRecord(this.record)
  }
  /**
   * A committed edit: the layout before it kept for Undo (20 steps), the piece in hand set (with its place in the saved
   * order), and the new layout sent.
   */
  private commit(next: { placed: readonly Piece[]; stored: readonly Piece[]; floor?: number; wall?: number } | null, lifted: Piece | null, at = this.liftedAt): void {
    this.undoSteps.push({ layout: this.record[this.home] ?? null, lifted: this.lifted, at: this.liftedAt, rot: this.rot })
    if (this.undoSteps.length > UNDO_STEPS) this.undoSteps.shift()
    this.lifted = lifted
    this.liftedAt = at
    if (!next) return
    const f = finishOf(this.record, this.home)
    this.send(layoutOf(next.floor ?? f.floor, next.wall ?? f.wall, next.placed, next.stored))
  }

  moveTo(c: number, r: number): void {
    const at = { c: clamp(c, 0, GRID - 1), r: clamp(r, this.first, GRID - 1) }
    if (at.c === this.cursor.c && at.r === this.cursor.r) return
    this.cursor = at
    this.quiet()
  }
  /**
   * The saved layout with piece `p` (the one picked up) back at its place in the saved order, fitted: what fitLayout
   * gave before the pickup, since every piece ahead of it is where it was.
   */
  private returned(p: Piece): { placed: Piece[]; stored: Piece[] } {
    const saved = this.record[this.home]?.pieces ?? []
    const at = clamp(this.liftedAt, 0, saved.length)
    return fitLayout(this.home, [...saved.slice(0, at), p, ...saved.slice(at)], (id) => this.owns(id))
  }
  /** The piece picked up goes back where it was (before another line is taken in hand). */
  private putBack(): void {
    const p = this.lifted
    if (!p) return
    this.commit(this.returned(p), null)
    this.rot = p.rot
  }
  private pickUp(p: Piece): void {
    const fit = this.fit()
    this.commit({ placed: fit.placed.filter((x) => x !== p), stored: fit.stored }, p, fit.placed.indexOf(p))
    this.rot = p.rot
    this.cursor = { c: p.c, r: p.r }
    this.say(`${nameOf(p.id)} picked up: Place puts it down, Undo puts it back`)
  }
  /** Place the piece in hand where it fits; else pick up the piece under the cursor; else say why not. */
  place(): void {
    const fit = this.fit()
    const hand = this.hand()
    const verdict = this.verdict(fit)
    if (hand && verdict === 'ok') {
      const moved = this.lifted !== null
      this.commit({ placed: [...fit.placed, hand], stored: fit.stored }, null)
      this.say(`${nameOf(hand.id)} ${moved ? 'moved' : 'placed'} at ${placeWords(this.home, this.cursor)}`)
      return
    }
    const under = this.lifted ? null : this.pieceAt(fit.placed, this.cursor.c, this.cursor.r)
    if (under) { this.pickUp(under); return }
    this.say(hand && verdict ? verdictWords(verdict, hand.id) : 'Nothing here to pick up: choose a piece in the strip')
  }
  /** Take the piece picked up out of the home, or the piece under the cursor. */
  remove(): void {
    if (this.lifted) {
      const p = this.lifted
      this.commit(null, null)
      this.say(`${nameOf(p.id)} taken out of the home`)
      return
    }
    const fit = this.fit()
    const under = this.pieceAt(fit.placed, this.cursor.c, this.cursor.r)
    if (!under) { this.say('Nothing here to remove'); return }
    this.commit({ placed: fit.placed.filter((x) => x !== under), stored: fit.stored }, null)
    this.say(`${nameOf(under.id)} removed`)
  }
  rotate(): void {
    if (!this.hand()) { this.say('Nothing in hand to turn: choose a piece in the strip'); return }
    this.rot = (this.rot + 1) & 3
    this.quiet()
  }
  choose(id: number): void {
    this.putBack()
    this.sel = id
    this.quiet()
  }
  setFinish(floor: number | undefined, wall: number | undefined): void {
    const f = finishOf(this.record, this.home)
    if ((floor ?? f.floor) === f.floor && (wall ?? f.wall) === f.wall) return
    const fit = this.fit()
    this.commit({ placed: fit.placed, stored: fit.stored, floor, wall }, this.lifted)
    this.say(floor !== undefined ? `Floor: ${FLOORS[floor].name}` : `Walls: ${WALLS[wall ?? 0].name}`)
  }
  /** The next or previous piece (the lines owned, in catalogue order; all nine while none is), or finish in its tab. */
  cycle(d: 1 | -1): void {
    const f = finishOf(this.record, this.home)
    if (this.tab === 1) { this.setFinish((f.floor + d + FLOORS.length) % FLOORS.length, undefined); return }
    if (this.tab === 2) { this.setFinish(undefined, (f.wall + d + WALLS.length) % WALLS.length); return }
    const mine = SHAPE_IDS.filter((id) => this.owns(id))
    const list = mine.length > 0 ? mine : SHAPE_IDS
    const at = this.sel === null ? -1 : list.indexOf(this.sel)
    this.choose(list[at < 0 ? (d > 0 ? 0 : list.length - 1) : (at + d + list.length) % list.length])
  }
  undo(): void {
    const step = this.undoSteps.pop()
    if (!step) { this.say('Nothing to undo'); return }
    this.lifted = step.lifted
    this.liftedAt = step.at
    this.rot = step.rot
    if ((this.record[this.home] ?? null) !== step.layout) this.send(step.layout)
    this.say('Undone')
  }
  /** Buy line `id` through the shopkeeper's gate (the same as the design house's), and take it in hand. */
  order(id: number): void {
    const r = this.io.keeper.buy(id)
    if (r.verdict !== GATE.bought) { this.say(r.message); return }
    this.choose(id)
    this.say(`${r.message}: move it into place and press Place`)
  }
  clear(): void {
    const fit = this.fit()
    if (fit.stored.length === 0) return
    this.commit({ placed: fit.placed, stored: [] }, this.lifted)
    this.say('The pieces not placed here are cleared')
  }
  turnView(d: 1 | -1): void {
    this.view = ((this.view + d + 4) & 3) as 0 | 1 | 2 | 3
    this.quiet()
  }
  toTab(i: number): void {
    this.tab = (i + TABS.length) % TABS.length
    this.quiet()
  }
  /** A press on a cell (the plan or the city): on the cursor's cell it places (or picks up); elsewhere the cursor goes there. */
  press(cell: { c: number; r: number } | null): void {
    if (!cell) return
    if (cell.c === this.cursor.c && cell.r === this.cursor.r) this.place()
    else this.moveTo(cell.c, cell.r)
  }
  /**
   * A right press on a cell (the plan or the city) removes what stands there. A press on no cell (the ray past the
   * room's floor, a wall, the doorway's band under the plan) does nothing, as a left press there does: Delete, X, the
   * pad's X and Remove take the piece under the cursor.
   */
  removeAt(cell: { c: number; r: number } | null): void {
    if (!cell) return
    this.moveTo(cell.c, cell.r)
    this.remove()
  }
  /** The wheel turns the piece: once per notch's worth of travel, and not faster than five times a second. */
  wheel(dy: number): void {
    const now = performance.now()
    this.wheelSum += dy
    if (Math.abs(this.wheelSum) < 40 || now - this.wheelAt < 200) return
    this.wheelSum = 0
    this.wheelAt = now
    this.rotate()
  }
  run(a: Act): void {
    if (typeof a === 'string') {
      switch (a) {
        case 'place': this.place(); return
        case 'rotate': this.rotate(); return
        case 'remove': this.remove(); return
        case 'undo': this.undo(); return
        case 'prev': this.cycle(-1); return
        case 'next': this.cycle(1); return
        case 'view': this.turnView(1); return
        case 'unview': this.turnView(-1); return
        case 'tabPrev': this.toTab(this.tab - 1); return
        case 'tabNext': this.toTab(this.tab + 1); return
        case 'clear': this.clear(); return
        case 'close': this.io.onClose(); return
      }
    }
    if ('move' in a) this.moveTo(this.cursor.c + a.move[0], this.cursor.r + a.move[1])
    else if ('tab' in a) this.toTab(a.tab)
    else if ('to' in a) this.moveTo(a.to.c, a.to.r)
    else if ('press' in a) this.press(a.press)
    else if ('removeAt' in a) this.removeAt(a.removeAt)
    else if ('wheel' in a) this.wheel(a.wheel)
    else if ('pick' in a) this.choose(a.pick)
    else if ('order' in a) this.order(a.order)
    else if ('floor' in a) this.setFinish(a.floor, undefined)
    else if ('wall' in a) this.setFinish(undefined, a.wall)
  }
  /** Someone stepping onto or off the cells by a piece changes what may go there ('you'): the pad's loop asks a few times a second. */
  refreshBlocked(): void {
    const b = this.io.hooks.blocked(this.home)
    const key = cellsKey(b)
    if (key === this.blockedKey) return
    this.blocked = b
    this.blockedKey = key
    this.io.changed()
  }
  /**
   * The visit ends (Done, Esc, the console, leaving the home, a room joined): a piece in hand goes back where it was
   * (its place in the saved order), so closing never loses one nor lets another take its spot, and the draft is taken away.
   */
  settle(): void {
    const p = this.lifted
    if (p) {
      const back = this.returned(p)
      this.lifted = null
      const f = finishOf(this.record, this.home)
      this.send(layoutOf(f.floor, f.wall, back.placed, back.stored))
    }
    this.io.hooks.setDraft(null)
  }
}

// ---------------------------------------------------------------- the left stick

/** The left stick between polls: armed once it has rested inside the dead zone, the direction it moves (−1: none), and when next. */
export interface StickState { armed: boolean; dir: number; next: number }

/**
 * One poll of the left stick at (lx, ly), at `now` ms: the direction the cursor moves this poll (an index into the
 * card's four steps: 0 toward the back, 1 to +c, 2 toward the doorway, 3 to −c), or −1 for none. Past STICK.dead it
 * moves at once, again after STICK.first ms and then every STICK.repeat ms while held; a stick held as the view opens
 * counts once it has been let go. The axis that leads picks the direction, and the direction held keeps it until the
 * other axis leads by STICK.turn: near a diagonal the stick's own noise would hand the lead from one axis to the other
 * every frame, and each change of direction moves at once, so the cursor would move every frame.
 */
export function stickStep(s: StickState, lx: number, ly: number, now: number): number {
  const ax = Math.abs(lx), ay = Math.abs(ly)
  if (Math.max(ax, ay) < STICK.dead) { s.armed = true; s.dir = -1; return -1 }
  if (!s.armed) return -1
  const across = s.dir < 0 ? ax >= ay : (s.dir & 1) === 1 ? ax + STICK.turn >= ay : ax >= ay + STICK.turn
  const dir = across ? (lx > 0 ? 1 : 3) : (ly > 0 ? 2 : 0)
  if (dir !== s.dir) { s.dir = dir; s.next = now + STICK.first; return dir }
  if (now < s.next) return -1
  s.next = now + STICK.repeat
  return dir
}

// ---------------------------------------------------------------- how a button got the focus

/** Whether `t` is a button (a DOM one, or anything that says it is), which Enter and Space press natively. */
const isButton = (t: EventTarget | null): boolean => (t as { tagName?: unknown } | null)?.tagName === 'BUTTON'

/**
 * How the focused control got the focus, decided when the focus moves (input.ts's rule): Chromium counts a key as
 * keyboard use (:focus-visible) before the key's own handlers run, so a button a mouse clicked reads as reached with
 * the keyboard inside the very next keydown. A focus that arrives while a pointer press is under way is the pointer's:
 * from pointerdown until its click (a finger's tap focuses only once it lifts), a Tab or the window losing focus. A
 * press on the control that already has the focus moves no focus, so it is the pointer's too. Focus coming back to
 * the control that had it (the window regained) keeps what it was. Enter and Space press a button reached with Tab,
 * and stay Place over one the pointer left focused.
 */
export class FocusOrigin {
  private pressing = false
  private pointer: EventTarget | null = null

  /** A pointer press begins; `focused` is the control that already has the focus when the press lands on it, else null. */
  pointerDown(focused: EventTarget | null): void {
    this.pressing = true
    if (focused) this.pointer = focused
  }
  /** The press ended in its click. */
  click(): void {
    this.pressing = false
  }
  /** A key goes down: Tab ends a press under way, so the focus it moves is the keyboard's. */
  key(code: string): void {
    if (code === 'Tab') this.pressing = false
  }
  /** The window lost the focus. */
  blur(): void {
    this.pressing = false
  }
  /** `target` takes the focus. */
  focusIn(target: EventTarget | null): void {
    if (target !== this.pointer) this.pointer = this.pressing ? target : null
  }
  /** Whether `t` is a button the keyboard gave the focus to (Tab, or the page itself), which Enter and Space press. */
  byKeys(t: EventTarget | null): boolean {
    return isButton(t) && t !== this.pointer
  }
}
