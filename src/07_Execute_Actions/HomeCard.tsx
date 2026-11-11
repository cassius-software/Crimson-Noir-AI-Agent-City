// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the card on a home's doorstep: B, E or the HUD's chip inside one of the seven homes
 * (01_Initialize_World/properties.ts) opens it. For a visitor it shows that home's deed (storeCatalog.ts, line 224 +
 * the home's index): the home's name and the address the host supplies, a line about the home (homeView.ts
 * CITY_LINES), its level and its price, and then Buy, or Claim (free) for the free loft, through the one shopkeeper
 * (shopkeeper.ts), so the doorstep and Lintel & Lumen's card can never disagree about what is owned or what it cost.
 * When the gate refuses, the card shows its reason instead; an owner sees "Yours". The purse line says whose credits
 * these are, as the store card's does. The Penthouse and the Sky-Mansion are sold for now as the residences at the
 * foot of their towers, and the card says that the sky floor opens later.
 *
 * For the owner it is where the home is furnished, unless the engine says why not yet: in a network room, which replays
 * the walk and knows nothing of the furniture, the deed view says so (leaving the home or putting on a headset closes
 * the card: App). The furnishing view has five tabs: the furniture (all nine of Lintel & Lumen's lines, each owned one
 * with how many of its cap stand here, each other one with its price and Order, through the same shopkeeper's gate, or
 * the gate's reason; and the pieces the saved layout keeps that are not placed here, with Clear), the floor and the
 * walls (free finishes), Rest (a rest at home, in the host's words), and Staff (the player's own agents posted at the
 * workstations here, through the host). Under them is the home's floor plan, 32 by 32
 * cells (02_Define_The_Rules/homeGrid.ts): the back at the top and the doorway at the bottom under an arrow, only this
 * home's own rows (a smaller home a shorter plan), the apron in front of the doorway hatched, every piece in its
 * finish's colour with its initial, a workstation's seat dotted, the people standing in the home as dots, and the
 * cursor with the piece in hand, green where it fits and red where it does not, with the reason said under the plan
 * (homeLayout.ts canPlace, in words). The engine shows the same draft in the city: the piece in hand as a ghost and a
 * camera under the ceiling looking at the cursor (setDraft), and a press on the city's canvas picks a cell through that
 * camera (a mouse hovering the plan moves the cursor; hovering the city does not, since that camera follows the
 * cursor). The visit, its state and every edit, is furnishVisit.ts's Visit: every committed edit goes to the host as
 * the whole record, which saves it and redraws the homes and their solids; a piece picked up leaves the home until it
 * is placed again, and Undo, another line or closing the card puts it back where it was. Undo takes back 20 edits.
 *
 * Esc, B, the close button or Done puts it away through the host. The listeners run in the capture phase, as the
 * store card's does, and take only the keys they handle, never H (the HUD's) nor ` (the console's, whose opening puts
 * the card away). In the deed view a pad's south face button presses the focused button and its d-pad moves focus
 * (padNav.ts); its east button and Menu close. In the furnishing view the card reads the pad itself, every animation
 * frame (padEdges: a button held when the view opens counts only from its next press, and the focus walk is off so
 * one press never both presses a button and places): the d-pad and the left stick move the cursor, A places, X
 * removes, Y turns, the shoulders change the piece (or the finish), the triggers the tab, View undoes, the right
 * stick turns the camera. Every button is at least 48 px for a finger, 8 px apart.
 * What breaks if it is removed? A home's deed can be bought only at the design house, the free loft cannot be claimed
 * where it stands, a visitor walking into a home has nothing to tell them what it is or what it costs, and nothing
 * can be furnished.
 */
import { useEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react'
import { SHOP_INFO } from '../01_Initialize_World/storefronts.ts'
import { APRON, DEPTH, GRID, HOME_PIECES } from '../02_Define_The_Rules/homeGrid.ts'
import { FLOORS, WALLS, footprint, pieceCells, shapeOf, type Finish, type Piece } from '../02_Define_The_Rules/homeLayout.ts'
import { isEditableTarget } from '../04_Connect_Hardware/input.ts'
import { TOUCH } from '../04_Connect_Hardware/touchLayout.ts'
import { finishOf, freshHomes, type HomeRecord } from '../05_Observe_Environment/homeStore.ts'
import {
  FocusOrigin, REST_TAB, STAFF_TAB, STICK, TABS, Visit, clamp, nameOf, placeWords, stickStep, verdictWords, type Act, type FurnishHooks, type StickState,
} from './furnishVisit.ts'
import { CITY_LINES, type Draft } from './homeView.ts'
import { padEdges, padsFor, readPads, usePadNav } from './padNav.ts'
import type { Shopkeeper } from './shopkeeper.ts'
import { GATE, credits, itemById } from './storeCatalog.ts'

/** What the card needs of the engine to furnish a home (furnishVisit.ts): App builds it over engine.ts. */
export type { FurnishHooks }

export interface HomeCardProps {
  /** Show the card (the host passes false while the veil covers the page, the console is open or the city is halted). */
  visible: boolean
  /** The home whose deed it shows, by its property index 0..6, or null. */
  home: number | null
  /** The one shopkeeper the page buys through. */
  keeper: Shopkeeper
  /** The home's name and its street address, as the host knows them (the city's grid, or a region's own places). */
  homeInfo?: { name: string; address: string }
  dark?: boolean
  /**
   * Whether the card reads the pad (padNav.ts): the host passes false while a city action waits for its OK, so the act
   * card alone answers the pad and one press never answers both cards.
   */
  pad?: boolean
  /**
   * Which pads are the player's, by index (stable across renders): in split screen the card is player 1's, so another
   * seat's pad, busy with its own car door and clock, never presses or moves through it. Absent: every pad.
   */
  padFrom?: (padIndex: number) => boolean
  /** The saved furnishing of the seven homes (homeStore.ts), as the host keeps it. */
  record?: HomeRecord
  /** A committed edit: the whole record with this home's layout replaced; the host saves it and redraws the homes. */
  onRecord?: (next: HomeRecord) => void
  /** The engine's side of furnishing (stable across renders); absent, an owner sees the deed view only. */
  furnish?: FurnishHooks | null
  onClose: () => void
}

/** Home `h`'s deed is catalogue line DEED + h, and its property bit is h (storeCatalog.ts). */
const DEED = 224

/** No home furnished: the record when the host hands none. */
const NO_RECORD: HomeRecord = freshHomes()

/** What the two tower deeds are until their sky floors open: the residence at the foot of the tower. */
const SKY_NOTES: Readonly<Record<number, string>> = Object.freeze({
  3: 'The residence at the foot of Crimson Tower (the sky floor opens later).',
  6: 'The residence at the foot of the Crown Spire (the sky floor opens later).',
})

/**
 * Whether a key press puts the card away: Esc, or B (the key that opens it) unless it is held down, chorded or typed
 * into a field. No other key is the card's, so H and ` always reach the page.
 */
function closes(e: KeyboardEvent): boolean {
  if (e.key === 'Escape') return true
  return e.code === 'KeyB' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditableTarget(e.target)
}

/** The card's glass, by daylight: the store card's, with the shops' teal for what may be bought. */
function themeOf(dark: boolean) {
  return {
    muted: dark ? 'text-slate-300/80' : 'text-slate-500',
    rule: dark ? 'border-white/10' : 'border-slate-900/10',
    pill: dark ? 'border-white/15 bg-white/10 hover:bg-white/20' : 'border-slate-900/15 bg-white/60 hover:bg-white',
    pillOn: dark ? 'border-white bg-white text-slate-900' : 'border-slate-900 bg-slate-900 text-white',
    buy: dark ? 'bg-teal-300 text-slate-950 hover:bg-teal-200' : 'bg-teal-700 text-white hover:bg-teal-800',
    off: dark ? 'border-white/10 text-slate-400' : 'border-slate-900/10 text-slate-400',
    yours: dark ? 'border-amber-300/60 text-amber-200' : 'border-amber-700/50 text-amber-800',
    primary: dark ? 'bg-white text-slate-900' : 'bg-slate-900 text-white',
  }
}
type Theme = ReturnType<typeof themeOf>

/** A button a finger, a mouse and a pad's focus can all use: 48 px tall, with a visible focus ring. */
const BUTTON = 'min-h-12 rounded-full text-[13px] outline-none focus-visible:ring-4 focus-visible:ring-teal-400/60'
/** The least a square icon button measures, and the room between two targets (touchLayout.ts TOUCH: 48 px, 8 px). */
const TARGET = Object.freeze({ minWidth: TOUCH.minTarget, minHeight: TOUCH.minTarget })
const GAP = Object.freeze({ gap: TOUCH.gap })

/** The card's size: the deed view's, and the furnishing view's (a bottom sheet on a phone, so the draft shows above it). */
const DEED_SIZE = 'max-h-[min(42rem,100%)] w-[min(26rem,100%)]'
const FURNISH_SIZE = 'max-h-[56%] w-full sm:max-h-[min(46rem,100%)] sm:w-[min(26rem,100%)]'

// ---------------------------------------------------------------- the furnishing view's pad, colours and keys

/** The standard mapping's buttons the card reads itself: the face buttons, the shoulders, the triggers, View, Menu, the d-pad. */
const BTN = Object.freeze({ a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, view: 8, menu: 9, up: 12, down: 13, left: 14, right: 15 })
/** Every button the furnishing view reads (one list, so each poll's held set is the next poll's). */
const PAD_BUTTONS: readonly number[] = Object.freeze(Object.values(BTN))
/** The deed view reads only East (B) and Menu itself, to close (usePadNav has A and the d-pad). */
const CLOSE_BUTTONS: readonly number[] = Object.freeze([BTN.b, BTN.menu])

/** A finish's colour on the plan and on its swatch (glass, for walls with no panels, has its own). */
const FINISH_COLOUR: Readonly<Record<Finish, string>> = Object.freeze({
  concrete: '#9ca3af',
  deck: '#b07a4a',
  trim: '#e2d9c3',
  masonry: '#a3543a',
  rail: '#3f4652',
  lit: '#38bdf8',
  planted: '#3fa34d',
})
const GLASS_COLOUR = '#bfdbfe'

/** The plan's own colours: the floor, the grid lines, the apron's hatching, people, the cursor, fits and does not. */
const PLAN = Object.freeze({
  floor: '#f1f5f9', floorDark: '#1e293b', line: 'rgba(15,23,42,0.08)', lineDark: 'rgba(255,255,255,0.08)',
  hatch: '#94a3b8', person: '#f59e0b', cursor: '#0ea5e9', ok: '#16a34a', bad: '#dc2626', door: '#0d9488',
  staff: '#7c3aed',
})
/** The band under the plan where the doorway's arrow stands, px. */
const DOOR_BAND = 14

/** The four directions the left stick moves the cursor: toward the back, +v, the doorway, −v. */
const STEP: readonly (readonly [number, number])[] = Object.freeze([[0, -1], [1, 0], [0, 1], [-1, 0]])

/** What each pad button asks of the furnishing view (section 7 of the plan). */
const PAD_ACT: Readonly<Record<number, Act>> = Object.freeze({
  [BTN.a]: 'place', [BTN.b]: 'close', [BTN.menu]: 'close', [BTN.x]: 'remove', [BTN.y]: 'rotate', [BTN.lb]: 'prev', [BTN.rb]: 'next',
  [BTN.lt]: 'tabPrev', [BTN.rt]: 'tabNext', [BTN.view]: 'undo',
  [BTN.up]: { move: STEP[0] }, [BTN.right]: { move: STEP[1] }, [BTN.down]: { move: STEP[2] }, [BTN.left]: { move: STEP[3] },
})

/**
 * The furnishing view's action for a key press: the arrows or W A S D move the cursor (Shift: four cells), Enter or
 * Space places (or picks up; in the Rest tab, rests; in the Staff tab, posts), R turns, Delete, Backspace or X removes
 * (in the Staff tab, stands down), Q and E change the piece (in the Staff tab, the agent), 1 to 5 the tab, Z or Ctrl+Z undoes, C turns the camera. In the Floor and Walls tabs ← and → choose the finish
 * instead. Never H (the HUD's) nor ` (the console's), never Esc or B (the card's close listener has those), and no
 * chord but Ctrl (or Cmd) + Z.
 * Null: not this view's key, so the page gets it.
 */
function keyAct(e: KeyboardEvent, tab: number): Act | null {
  if (e.code === 'KeyZ' && !e.altKey) return 'undo'
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  const n = e.shiftKey ? 4 : 1
  const finish = tab === 1 || tab === 2
  switch (e.code) {
    case 'ArrowUp': case 'KeyW': return { move: [0, -n] }
    case 'ArrowDown': case 'KeyS': return { move: [0, n] }
    case 'ArrowLeft': return finish ? 'prev' : { move: [-n, 0] }
    case 'ArrowRight': return finish ? 'next' : { move: [n, 0] }
    case 'KeyA': return { move: [-n, 0] }
    case 'KeyD': return { move: [n, 0] }
    case 'Enter': case 'NumpadEnter': case 'Space': return 'place'
    case 'KeyR': return 'rotate'
    case 'Delete': case 'Backspace': case 'KeyX': return 'remove'
    case 'KeyQ': return 'prev'
    case 'KeyE': return 'next'
    case 'Digit1': return { tab: 0 }
    case 'Digit2': return { tab: 1 }
    case 'Digit3': return { tab: 2 }
    case 'Digit4': return { tab: 3 }
    case 'Digit5': return { tab: 4 }
    case 'KeyC': return 'view'
    default: return null
  }
}

/** The people a blocked-cells table shows (engine.ts blockedCells): one point per patch of touching cells, at its middle, in cells. */
function people(blocked: Uint8Array): { x: number; y: number }[] {
  const seen = new Uint8Array(blocked.length)
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < blocked.length; i++) {
    if (!blocked[i] || seen[i]) continue
    let sx = 0, sy = 0, n = 0
    const stack = [i]
    seen[i] = 1
    while (stack.length > 0) {
      const at = stack.pop()!, c = at % GRID, r = (at - c) / GRID
      sx += c; sy += r; n++
      for (const [dc, dr] of STEP) {
        const nc = c + dc, nr = r + dr, j = nr * GRID + nc
        if (nc >= 0 && nc < GRID && nr >= 0 && nr < GRID && blocked[j] && !seen[j]) { seen[j] = 1; stack.push(j) }
      }
    }
    out.push({ x: sx / n + 0.5, y: sy / n + 0.5 })
  }
  return out
}

/** What the plan draws. */
interface PlanScene {
  home: number
  /** One cell's side, CSS px. */
  cell: number
  placed: readonly Piece[]
  hand: Piece | null
  ok: boolean
  cursor: { c: number; r: number }
  blocked: Uint8Array
  dark: boolean
  /** The agents posted here (Visit.staffMarks), and the workstation under the cursor in the Staff tab. */
  staff: readonly { x: number; y: number; initial: string }[]
  seat: Piece | null
}

/** Fills piece `p`'s cells: those its solid blocks in `colour`, the walkable rest fainter, a seat dotted, and its initial. */
function drawPiece(ctx: CanvasRenderingContext2D, p: Piece, s: number, colour: string, dark: boolean): void {
  const { cells, blocked, seat } = pieceCells(p)
  ctx.fillStyle = colour
  for (const at of cells) {
    const c = at % GRID, r = (at - c) / GRID
    ctx.globalAlpha = blocked.includes(at) ? 1 : 0.4
    ctx.fillRect(c * s + 0.5, r * s + 0.5, s - 1, s - 1)
  }
  ctx.globalAlpha = 1
  ctx.fillStyle = dark ? '#f8fafc' : '#0f172a'
  for (const at of seat) {
    const c = at % GRID, r = (at - c) / GRID
    for (const [dx, dy] of [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]]) ctx.fillRect((c + dx) * s - 1, (r + dy) * s - 1, 2, 2)
  }
  const f = footprint(p)
  if (!f) return
  ctx.font = `600 ${Math.max(8, Math.floor(s * 0.9))}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#0f172a'
  ctx.fillText(nameOf(p.id).charAt(0), (f.c + f.cols / 2) * s, (f.r + f.rows / 2) * s)
}

/**
 * Draws the floor plan: the back wall at the top and the doorway at the bottom (an arrow under the apron pointing in),
 * column c growing to the right as seen from the doorway; only the home's own rows (a shallower home is a shorter plan,
 * so the first screen is never a dark band of rows the home does not have), the apron hatched, every piece, the people
 * standing here as dots, and the cursor with the piece in hand, green where it fits and red where it does not. Drawn in
 * the grid's own rows, shifted up by the home's first row. Sharp at the screen's pixel ratio.
 */
function drawPlan(el: HTMLCanvasElement | null, o: PlanScene): void {
  const ctx = el?.getContext('2d')
  if (!el || !ctx) return
  const first = GRID - DEPTH[o.home]
  const s = o.cell, w = GRID * s, h = DEPTH[o.home] * s + DOOR_BAND
  const ratio = clamp(Math.round(globalThis.devicePixelRatio || 1), 1, 3)
  if (el.width !== w * ratio || el.height !== h * ratio) { el.width = w * ratio; el.height = h * ratio }
  ctx.setTransform(ratio, 0, 0, ratio, 0, -first * s * ratio)
  ctx.clearRect(0, first * s, w, h)
  ctx.fillStyle = o.dark ? PLAN.floorDark : PLAN.floor
  ctx.fillRect(0, first * s, w, (GRID - first) * s)
  ctx.strokeStyle = o.dark ? PLAN.lineDark : PLAN.line
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i <= GRID; i++) { ctx.moveTo(i * s + 0.5, first * s); ctx.lineTo(i * s + 0.5, GRID * s) }
  for (let r = first; r <= GRID; r++) { ctx.moveTo(0, r * s + 0.5); ctx.lineTo(w, r * s + 0.5) }
  ctx.stroke()
  // The apron, hatched: nothing is ever placed in front of the doorway.
  const ax = APRON.c0 * s, ay = APRON.r0 * s, aw = (APRON.c1 - APRON.c0 + 1) * s, ah = (APRON.r1 - APRON.r0 + 1) * s
  ctx.save()
  ctx.beginPath()
  ctx.rect(ax, ay, aw, ah)
  ctx.clip()
  ctx.strokeStyle = PLAN.hatch
  ctx.beginPath()
  for (let d = -ah; d < aw; d += 6) { ctx.moveTo(ax + d, ay + ah); ctx.lineTo(ax + d + ah, ay) }
  ctx.stroke()
  ctx.restore()
  for (const p of o.placed) drawPiece(ctx, p, s, FINISH_COLOUR[shapeOf(p.id)?.boxes[0]?.finish ?? 'concrete'], o.dark)
  ctx.fillStyle = PLAN.person
  for (const { x, y } of people(o.blocked)) {
    ctx.beginPath()
    ctx.arc(x * s, y * s, Math.max(2.5, s * 0.32), 0, Math.PI * 2)
    ctx.fill()
  }
  // The agents posted here: a violet disc with their initial at the station.
  ctx.font = `700 ${Math.max(8, Math.floor(s * 0.8))}px system-ui, sans-serif`
  for (const m of o.staff) {
    ctx.fillStyle = PLAN.staff
    ctx.beginPath()
    ctx.arc(m.x * s, m.y * s, Math.max(4, s * 0.55), 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.fillText(m.initial, m.x * s, m.y * s)
  }
  // The piece in hand where it would go, and the cursor round its footprint (one cell with nothing in hand).
  const colour = o.hand === null ? PLAN.cursor : o.ok ? PLAN.ok : PLAN.bad
  if (o.hand) {
    ctx.globalAlpha = 0.55
    drawPiece(ctx, o.hand, s, colour, o.dark)
    ctx.globalAlpha = 1
  }
  const f = (o.hand && footprint(o.hand)) ?? (o.seat && footprint(o.seat)) ?? { c: o.cursor.c, r: o.cursor.r, cols: 1, rows: 1 }
  ctx.strokeStyle = colour
  ctx.lineWidth = 2
  ctx.strokeRect(f.c * s + 1, f.r * s + 1, f.cols * s - 2, f.rows * s - 2)
  const mid = ((APRON.c0 + APRON.c1 + 1) / 2) * s
  ctx.fillStyle = PLAN.door
  ctx.beginPath()
  ctx.moveTo(mid, GRID * s + 2)
  ctx.lineTo(mid - 7, GRID * s + DOOR_BAND - 1)
  ctx.lineTo(mid + 7, GRID * s + DOOR_BAND - 1)
  ctx.closePath()
  ctx.fill()
}

/** The card's width in CSS px while `active` (the plan's cells are sized from it); 416 until it is measured. */
function useWidth(ref: RefObject<HTMLElement | null>, active: boolean): number {
  const [width, setWidth] = useState(416)
  useEffect(() => {
    const el = ref.current
    if (!active || !el) return
    const read = () => setWidth(Math.round(el.getBoundingClientRect().width) || 416)
    read()
    if (typeof ResizeObserver !== 'function') return
    const watch = new ResizeObserver(read)
    watch.observe(el)
    return () => watch.disconnect()
  }, [ref, active])
  return width
}

// ---------------------------------------------------------------- the furnishing view

interface FurnisherProps {
  home: number
  keeper: Shopkeeper
  record: HomeRecord
  onRecord: (next: HomeRecord) => void
  hooks: FurnishHooks
  pad: boolean
  padFrom?: (padIndex: number) => boolean
  width: number
  dark: boolean
  t: Theme
  onClose: () => void
}

function Furnisher({ home, keeper, record, onRecord, hooks, pad, padFrom, width, dark, t, onClose }: FurnisherProps) {
  const [, changed] = useReducer((n: number) => n + 1, 0)
  const [visit] = useState(() => new Visit(home, record, { keeper, onRecord, hooks, onClose, changed }))
  // The visit reaches each committed render's props, and builds on a record handed in that it did not make.
  useEffect(() => { visit.connect({ keeper, onRecord, hooks, onClose, changed }) }, [visit, keeper, onRecord, hooks, onClose])
  useEffect(() => { visit.adopt(record) }, [visit, record])

  // ------------------------------------------------ what this render shows
  const fit = visit.fit()
  const hand = visit.hand()
  const verdict = visit.verdict(fit)
  const staffTab = visit.tab === STAFF_TAB, seat = staffTab ? visit.station(fit) : null
  const under = hand ? null : visit.pieceAt(fit.placed, visit.cursor.c, visit.cursor.r)
  const finish = finishOf(visit.record, home)
  const counts = new Map<number, number>()
  for (const p of fit.placed) counts.set(p.id, (counts.get(p.id) ?? 0) + 1)
  const rows = keeper.rows('designHouse', null).filter((r) => r.item.kind === 'furniture')
  const cell = Math.max(9, Math.floor(Math.min(width - 40, 384) / GRID))
  const where = placeWords(home, visit.cursor)
  const reason = visit.said
    || (staffTab ? visit.staffLine() : hand && verdict ? `${nameOf(hand.id)} at ${where}: ${verdictWords(verdict, hand.id)}`
      : under ? `${nameOf(under.id)} at ${where}: Place picks it up, Remove takes it out`
        : `Nothing in hand at ${where}: choose a piece in the strip`)
  const { c, r } = visit.cursor
  const handId = hand?.id ?? null, rot = visit.rot, view = visit.view, ok = verdict === 'ok'
  const draft = useMemo((): Draft => ({ home, cursor: { c, r }, piece: handId === null ? null : { id: handId, c, r, rot }, ok, view }), [home, c, r, handId, rot, ok, view])

  // Furnishing begins in the engine (harmless when it already has), the draft follows every cursor, piece and view
  // change, and the visit settles when it ends.
  useEffect(() => { hooks.begin(home) }, [hooks, home])
  useEffect(() => { hooks.setDraft(draft) }, [hooks, draft])
  useEffect(() => () => visit.settle(), [visit])

  // The keys: captured, and only this view's (keyAct), never H nor `; Esc and B are the card's close listener's. How
  // a button got the focus is followed as the focus moves (FocusOrigin), since by its keydown a button a mouse
  // clicked already reads :focus-visible.
  useEffect(() => {
    const origin = new FocusOrigin()
    const onPointer = (e: PointerEvent) => {
      const active = document.activeElement
      origin.pointerDown(active && e.target instanceof Node && active.contains(e.target) ? active : null)
    }
    const onClick = () => origin.click()
    const onFocus = (e: FocusEvent) => origin.focusIn(e.target)
    const onBlur = () => origin.blur()
    const onKey = (e: KeyboardEvent) => {
      origin.key(e.code)
      if (isEditableTarget(e.target)) return
      const a = keyAct(e, visit.tab)
      if (a === null) return
      // A button reached with Tab keeps Enter and Space: they press it, as they press any button. One a pointer left
      // focused does not: they place.
      if (a === 'place' && origin.byKeys(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      // Held down, only the cursor keeps moving; a held Place, Remove or Undo acts once.
      if (e.repeat && typeof a === 'string') return
      visit.run(a)
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('focusin', onFocus, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('focusin', onFocus, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [visit])

  // The pad, every animation frame: padEdges, so a button already held when the view opened counts from its next
  // press; the sticks as the plan says. And a few times a second, who stands where.
  useEffect(() => {
    let raf = 0
    let prev: Set<string> = new Set()
    let frame = 0
    const stick: StickState = { armed: false, dir: -1, next: 0 }
    const turn = { armed: false, held: false }
    const poll = (now: number) => {
      if (++frame % 10 === 0) visit.refreshBlocked()
      if (pad) {
        const pads = padsFor(readPads(), padFrom)
        const { held, down } = padEdges(prev, pads, PAD_BUTTONS)
        prev = held
        for (const b of down) {
          const a = PAD_ACT[b]
          if (!a) continue
          visit.run(a)
          if (a === 'close') return
        }
        // The sticks of the standard-mapped pads only (another pad's axes may be pedals); a stick held as the view
        // opens counts once it has been let go (stickStep).
        let lx = 0, ly = 0, rx = 0
        for (const p of pads) {
          if (!p || p.mapping !== 'standard') continue
          const [ax = 0, ay = 0, bx = 0] = p.axes
          if (Math.hypot(ax, ay) > Math.hypot(lx, ly)) { lx = ax; ly = ay }
          if (Math.abs(bx) > Math.abs(rx)) rx = bx
        }
        const dir = stickStep(stick, lx, ly, now)
        if (dir >= 0) visit.run({ move: STEP[dir] })
        if (Math.abs(rx) < STICK.dead) { turn.armed = true; turn.held = false }
        else if (turn.armed && !turn.held) { turn.held = true; visit.run(rx > 0 ? 'view' : 'unview') }
      }
      raf = requestAnimationFrame(poll)
    }
    raf = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(raf)
  }, [visit, pad, padFrom])

  // A pointer on the city's canvas, through the draft camera (pickCell): a press on the cursor's cell places, a press
  // elsewhere moves the cursor there, the right button removes, the wheel turns. Hovering it does not move the cursor:
  // the draft camera follows the cursor, so the cell under a resting pointer changes with every move, and a hover
  // that moved the cursor would chase itself across the room (the plan below takes the hover instead).
  useEffect(() => {
    const canvas = hooks.canvas()
    if (!canvas) return
    const pick = (e: PointerEvent) => visit.io.hooks.pickCell(e.clientX, e.clientY)
    const onDown = (e: PointerEvent) => {
      if (e.button === 2) { e.preventDefault(); visit.run({ removeAt: pick(e) }); return }
      if (e.button === 0) visit.run({ press: pick(e) })
    }
    const onMenu = (e: Event) => e.preventDefault()
    const onWheel = (e: WheelEvent) => { e.preventDefault(); visit.run({ wheel: e.deltaY }) }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('contextmenu', onMenu)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('contextmenu', onMenu)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [visit, hooks])

  // The same on the plan, by its own cells, where a mouse's hover also moves the cursor (the plan stays still).
  const planRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = planRef.current
    if (!el) return
    const cellOf = (e: PointerEvent): { c: number; r: number } | null => {
      const b = el.getBoundingClientRect(), size = b.width / GRID
      if (!(size > 0)) return null
      const at = { c: Math.floor((e.clientX - b.left) / size), r: visit.first + Math.floor((e.clientY - b.top) / size) }
      return at.c >= 0 && at.c < GRID && at.r >= visit.first && at.r < GRID ? at : null
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const at = cellOf(e)
      if (at) visit.run({ to: at })
    }
    const onDown = (e: PointerEvent) => {
      if (e.button === 2) { e.preventDefault(); visit.run({ removeAt: cellOf(e) }); return }
      if (e.button === 0) visit.run({ press: cellOf(e) })
    }
    const onMenu = (e: Event) => e.preventDefault()
    const onWheel = (e: WheelEvent) => { e.preventDefault(); visit.run({ wheel: e.deltaY }) }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('contextmenu', onMenu)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('contextmenu', onMenu)
      el.removeEventListener('wheel', onWheel)
    }
  }, [visit])
  useEffect(() => {
    drawPlan(planRef.current, { home, cell, placed: fit.placed, hand, ok, cursor: { c, r }, blocked: visit.blocked, dark, staff: visit.staffMarks(), seat: seat?.p ?? null })
  })

  const restId = `home-rest-${home}`
  const staffId = `home-staff-${home}`
  const inHandName = visit.inHand()
  const swatch = (colour: string) => <span aria-hidden="true" className={`inline-block h-5 w-5 shrink-0 rounded-full border ${t.rule}`} style={{ background: colour }} />
  const undoOff = visit.undoSteps.length === 0
  return (
    <>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-2"
        data-furnishing
        data-cursor={`${c},${r}`}
        data-piece={handId ?? ''}
        data-rot={rot}
        data-fit={verdict ?? ''}
        data-placed={fit.placed.length}
        data-view={view}
      >
        <div role="tablist" aria-label="Furnish, rest or staff" className="mt-2 flex flex-wrap" style={GAP}>
          {TABS.map((name, i) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={visit.tab === i}
              onClick={() => visit.run({ tab: i })}
              className={`${BUTTON} flex-1 border px-3 ${visit.tab === i ? t.pillOn : t.pill}`}
              data-action="tab"
              data-tab={i}
              data-touch
            >
              {name}
            </button>
          ))}
        </div>

        {visit.tab === 0 && (
          <ul className="mt-3 flex overflow-x-auto pb-1" style={GAP} aria-label="Furniture" data-strip>
            {rows.map(({ item, verdict: gate, why, owned }) => {
              const cap = shapeOf(item.id)?.cap ?? 0
              const n = counts.get(item.id) ?? 0
              const chosen = visit.lifted === null && visit.sel === item.id
              return (
                <li key={item.id} className={`flex w-36 shrink-0 flex-col rounded-2xl border p-2 ${t.rule}`} style={GAP} data-line={item.id} data-owned={owned || undefined}>
                  <button
                    type="button"
                    onClick={() => visit.run({ pick: item.id })}
                    aria-pressed={chosen}
                    aria-label={`${item.name}: ${owned ? `${n} of ${cap} placed here` : `${credits(item.price)}, not yours yet`}`}
                    className={`${BUTTON} flex items-center gap-2 border px-3 text-left ${chosen ? t.pillOn : t.pill}`}
                    data-action="pick"
                    data-touch
                  >
                    {swatch(FINISH_COLOUR[shapeOf(item.id)?.boxes[0]?.finish ?? 'concrete'])}
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-[12px] font-semibold">{nameOf(item.id)}</span>
                      <span className="block text-[11px]" data-count>{owned ? `${n}/${cap} placed` : credits(item.price)}</span>
                    </span>
                  </button>
                  {!owned && (gate === GATE.bought ? (
                    <button
                      type="button"
                      onClick={() => visit.run({ order: item.id })}
                      aria-label={`Order the ${item.name} for ${credits(item.price)}`}
                      className={`${BUTTON} px-3 font-semibold ${t.buy}`}
                      data-action="order"
                      data-touch
                    >
                      Order
                    </button>
                  ) : (
                    <span className={`text-[11px] leading-snug ${t.muted}`} data-why>{why}</span>
                  ))}
                </li>
              )
            })}
          </ul>
        )}

        {(visit.tab === 1 || visit.tab === 2) && (
          <div className="mt-3 grid grid-cols-2" style={GAP} role="radiogroup" aria-label={visit.tab === 1 ? 'Floor' : 'Walls'} data-finishes={visit.tab === 1 ? 'floor' : 'walls'}>
            {(visit.tab === 1 ? FLOORS : WALLS).map((line, i) => {
              const on = (visit.tab === 1 ? finish.floor : finish.wall) === i
              return (
                <button
                  key={line.name}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => visit.run(visit.tab === 1 ? { floor: i } : { wall: i })}
                  className={`${BUTTON} flex items-center gap-2 border px-3 text-left ${on ? t.pillOn : t.pill}`}
                  data-action={visit.tab === 1 ? 'floor' : 'wall'}
                  data-finish={i}
                  data-touch
                >
                  {swatch(line.style ? FINISH_COLOUR[line.style] : GLASS_COLOUR)}
                  <span className="min-w-0 flex-1 truncate">{line.name}</span>
                </button>
              )
            })}
          </div>
        )}

        {visit.tab === REST_TAB && (
          <div id={restId} className={`mt-3 rounded-2xl border px-3 py-2 text-[12px] leading-snug ${t.rule}`} data-rest>
            {(hooks.rest?.offer(home).lines ?? ['Resting is not offered here']).map((line) => <p key={line}>{line}</p>)}
            <p className={`mt-1 ${t.muted}`}>{"Enter, Space, the pad's south button or Rest below rests here."}</p>
          </div>
        )}

        {staffTab && (
          <div id={staffId} className="mt-3" data-staff>
            <div role="group" className="flex overflow-x-auto pb-1" style={GAP} aria-label="Your agents" data-agents>
              {visit.staffAgents().map((a) => {
                const at = visit.whereIs(a)
                return (
                  <button
                    key={a.name}
                    type="button"
                    onClick={() => visit.run({ agent: a.name })}
                    aria-pressed={inHandName === a.name}
                    aria-label={`${a.name}: ${at}`}
                    className={`${BUTTON} shrink-0 border px-3 text-left leading-tight ${inHandName === a.name ? t.pillOn : t.pill}`}
                    data-action="agent"
                    data-touch
                  >
                    <span className="block font-semibold">{a.name}</span>
                    <span className="block text-[12px]">{at}</span>
                  </button>
                )
              })}
            </div>
            <div role="group" className="mt-2 grid grid-cols-2" style={GAP} aria-label="Workstations here" data-stations>
              {visit.stations(fit).map((p, i) => {
                const who = visit.who(p)?.name ?? 'Nobody'
                return (
                  <button
                    key={`${p.c},${p.r}`}
                    type="button"
                    onClick={() => visit.run({ press: { c: p.c, r: p.r } })}
                    aria-pressed={seat?.n === i + 1}
                    aria-label={`Workstation ${i + 1}, ${placeWords(home, p)}: ${who}`}
                    className={`${BUTTON} border px-3 text-left leading-tight ${seat?.n === i + 1 ? t.pillOn : t.pill}`}
                    data-action="station"
                    data-seat={`${p.c},${p.r}`}
                    data-touch
                  >
                    Workstation {i + 1} · {who}
                  </button>
                )
              })}
            </div>
            <p className={`mt-2 text-[12px] leading-snug ${t.muted}`}>Posted agents stand there between visits, and step away while out with you.</p>
          </div>
        )}

        {fit.stored.length > 0 && (
          <div className={`mt-3 flex flex-wrap items-center rounded-2xl border px-3 py-2 ${t.rule}`} style={GAP} data-stored={fit.stored.length}>
            <span className="min-w-0 flex-1 text-[12px] leading-snug">
              Not placed here ({fit.stored.length}) · <span className={t.muted}>{fit.stored.map((p) => nameOf(p.id)).join(', ')}</span>
            </span>
            <button type="button" onClick={() => visit.run('clear')} aria-label="Clear the pieces not placed here" className={`${BUTTON} border px-4 ${t.pill}`} data-action="clear" data-touch>Clear</button>
          </div>
        )}

        <canvas
          ref={planRef}
          role="img"
          aria-label={`Floor plan: the back wall at the top, the doorway at the bottom; ${fit.placed.length} of ${HOME_PIECES} pieces placed; the cursor at ${where}${staffTab ? `; ${visit.staffMarks().length} of ${visit.stations(fit).length} workstations staffed` : ''}`}
          className="mx-auto mt-3 block touch-none select-none"
          style={{ width: GRID * cell, height: DEPTH[home] * cell + DOOR_BAND }}
          data-plan
        />
        <p className="mt-2 min-h-[2.5rem] text-[12px] leading-snug" role="status" aria-live="polite" data-reason>{reason}</p>
      </div>

      <div role="toolbar" aria-label="Furnishing" className={`flex flex-wrap items-center border-t px-5 pt-3 ${t.rule}`} style={GAP}>
        <button type="button" onClick={() => visit.run('prev')} aria-label={staffTab ? 'Previous agent (Q)' : visit.tab === 1 || visit.tab === 2 ? 'Previous finish (Q)' : 'Previous piece (Q)'} className={`${BUTTON} border ${t.pill}`} style={TARGET} data-action="prev" data-touch>◀</button>
        <button type="button" onClick={() => visit.run('next')} aria-label={staffTab ? 'Next agent (E)' : visit.tab === 1 || visit.tab === 2 ? 'Next finish (E)' : 'Next piece (E)'} className={`${BUTTON} border ${t.pill}`} style={TARGET} data-action="next" data-touch>▶</button>
        <button type="button" onClick={() => visit.run('rotate')} aria-label="Rotate the piece (R)" className={`${BUTTON} border px-3 ${t.pill}`} style={TARGET} data-action="rotate" data-touch>Rotate</button>
        {visit.tab === REST_TAB ? (
          <button type="button" onClick={() => visit.run('place')} aria-label="Rest here (Enter)" aria-describedby={restId} className={`${BUTTON} px-4 font-semibold ${t.buy}`} style={TARGET} data-action="rest" data-touch>Rest</button>
        ) : (
          <button type="button" onClick={() => visit.run('place')} aria-label={staffTab ? `Post ${inHandName ?? 'an agent'} here (Enter)` : hand ? `Place the ${nameOf(hand.id)} (Enter)` : 'Pick up the piece under the cursor (Enter)'} aria-describedby={staffTab ? staffId : undefined} className={`${BUTTON} px-4 font-semibold ${t.buy}`} style={TARGET} data-action="place" data-touch>{staffTab ? 'Post' : 'Place'}</button>
        )}
        <button type="button" onClick={() => visit.run('remove')} aria-label={staffTab ? 'Stand down (Delete)' : 'Remove the piece (Delete)'} className={`${BUTTON} border px-3 ${t.pill}`} style={TARGET} data-action="remove" data-touch>{staffTab ? 'Stand down' : 'Remove'}</button>
        <button type="button" onClick={() => visit.run('undo')} disabled={undoOff} aria-label="Undo (Z)" className={`${BUTTON} border px-3 ${undoOff ? `${t.off} cursor-not-allowed` : t.pill}`} style={TARGET} data-action="undo" data-touch>Undo</button>
        <button type="button" onClick={() => visit.run('view')} aria-label="Turn the camera (C)" className={`${BUTTON} border px-3 ${t.pill}`} style={TARGET} data-action="view" data-touch>View</button>
        <button type="button" onClick={onClose} aria-label="Done (Esc)" className={`${BUTTON} px-4 font-semibold ${t.primary}`} style={TARGET} data-action="done" data-touch>Done</button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- the card

export function HomeCard({ visible, home, keeper, homeInfo, dark = false, pad = true, padFrom, record = NO_RECORD, onRecord, furnish = null, onClose }: HomeCardProps) {
  const cardRef = useRef<HTMLElement>(null)
  // The shopkeeper's every change (a purchase here or at the design house, a reset from the console) redraws the card.
  const [, setVersion] = useState(0)
  useEffect(() => keeper.onChange(() => setVersion((v) => v + 1)), [keeper])
  // What the last press did, said once (a live region), at the home it was said at (another home's card starts quiet).
  const [said, setSaid] = useState<{ home: number | null; text: string }>({ home: null, text: '' })
  const item = home !== null ? itemById(DEED + home) : null
  const open = visible && item !== null && item.kind === 'deed'
  const owned = item !== null && keeper.owns(item.id)
  // The owner furnishes here, unless the engine says why not yet (then the deed view says it).
  const refusal = open && owned && furnish !== null && home !== null ? furnish.refusal(home) : null
  const furnishing = open && owned && furnish !== null && onRecord !== undefined && refusal === null
  usePadNav(cardRef, open && pad && !furnishing, padFrom)
  const width = useWidth(cardRef, open)

  // The engine's refusal changes by itself (a network room joined or left, a headset put on): read every frame while
  // an owner's card is open, and the card drawn again when it changes.
  useEffect(() => {
    if (!open || !owned || !furnish || home === null) return
    let raf = 0
    let last = furnish.refusal(home)
    const poll = () => {
      const now = furnish.refusal(home)
      if (now !== last) { last = now; setVersion((v) => v + 1) }
      raf = requestAnimationFrame(poll)
    }
    raf = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(raf)
  }, [open, owned, furnish, home])

  // Esc and B put the card away (captured, so the game's own key handling never sees them while the card is open).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (!closes(e)) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    cardRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, home, onClose])

  // The deed view's pad: East (B) and Menu close it (the furnishing view reads its own pad).
  useEffect(() => {
    if (!open || !pad || furnishing) return
    let raf = 0
    let prev: Set<string> = new Set()
    const poll = () => {
      const { held, down } = padEdges(prev, padsFor(readPads(), padFrom), CLOSE_BUTTONS)
      prev = held
      if (down.has(BTN.b) || down.has(BTN.menu)) { onClose(); return }
      raf = requestAnimationFrame(poll)
    }
    raf = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(raf)
  }, [open, pad, furnishing, padFrom, onClose])

  if (!open || home === null || !item) return null
  const t = themeOf(dark)
  const glass = dark
    ? 'border-white/10 bg-slate-900/70 text-slate-50 shadow-[0_20px_60px_rgba(0,0,0,0.45)]'
    : 'border-white/70 bg-white/80 text-slate-900 shadow-[0_20px_60px_rgba(15,23,42,0.28)]'
  const name = homeInfo?.name ?? item.name
  const address = homeInfo?.address ?? ''
  const row = keeper.rows(item.shop, null).find((r) => r.item.id === item.id)
  const verdict = row?.verdict ?? GATE.unavailable
  const free = item.price === 0
  const w = keeper.purse
  const sky = SKY_NOTES[home]

  const buy = () => {
    const r = keeper.buy(item.id)
    setSaid({ home, text: r.verdict === GATE.bought ? (address ? `${name} is yours: ${address}` : `${name} is yours`) : r.message })
  }

  return (
    <div className="ui-zoom pointer-events-none absolute inset-0 z-30 flex items-end justify-end p-4 font-sans text-[13px] antialiased sm:items-center">
      <aside
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        aria-label={furnishing ? `Furnish ${name}` : name}
        data-home={home}
        data-verdict={verdict}
        data-owned={owned || undefined}
        data-furnish={furnishing || undefined}
        className={`pointer-events-auto flex ${furnishing ? FURNISH_SIZE : DEED_SIZE} flex-col rounded-3xl border backdrop-blur-2xl backdrop-saturate-150 ${glass} outline-none`}
      >
        <div className="flex items-start gap-3 px-5 pt-4">
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold leading-tight">{name}</div>
            {address && <div className={`text-[11px] uppercase tracking-wide ${t.muted}`} data-place>{address}</div>}
          </div>
          {furnishing && <span className={`shrink-0 self-center rounded-full border px-3 py-1 text-[12px] font-semibold ${t.yours}`} data-yours>Yours</span>}
          <button type="button" onClick={onClose} aria-label="Close" className={`${BUTTON} min-w-12 shrink-0 border ${t.pill}`} data-touch>×</button>
        </div>

        {furnishing && furnish && onRecord ? (
          <Furnisher key={home} home={home} keeper={keeper} record={record} onRecord={onRecord} hooks={furnish} pad={pad} padFrom={padFrom} width={width} dark={dark} t={t} onClose={onClose} />
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
              <p className="mt-2 leading-snug" data-tagline>{CITY_LINES[home]}</p>
              {sky && <p className={`mt-1 text-[12px] leading-snug ${t.muted}`} data-sky>{sky}</p>}

              <div className={`mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border px-3 py-2 ${t.rule}`} data-item={item.id}>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">Level {item.level} · {free ? 'Free' : credits(item.price)}</div>
                  {!owned && verdict !== GATE.bought && <div className={`text-[11px] leading-snug ${t.muted}`} data-why>{row?.why ?? 'not for sale'}</div>}
                </div>
                {owned ? (
                  <span className={`rounded-full border px-4 py-1.5 text-[13px] font-semibold ${t.yours}`} data-yours>Yours</span>
                ) : (
                  <button
                    type="button"
                    onClick={buy}
                    disabled={verdict !== GATE.bought}
                    title={verdict !== GATE.bought ? row?.why : undefined}
                    className={`${BUTTON} px-5 font-semibold ${verdict === GATE.bought ? t.buy : `border ${t.off} cursor-not-allowed`}`}
                    data-action="buy"
                    data-touch
                  >
                    {free ? 'Claim (free)' : 'Buy'}
                  </button>
                )}
              </div>
              {owned && refusal && <p className={`mt-2 text-[12px] leading-snug ${t.muted}`} data-refusal>{refusal}</p>}
              {owned && refusal && furnish?.rest && <p className={`mt-1 text-[12px] leading-snug ${t.muted}`} data-rest-wait>Resting here waits for the same reason.</p>}

              <div className={`mt-2 flex items-baseline justify-between gap-2 rounded-2xl border px-3 py-2 ${t.rule}`} data-purse>
                <span className="font-semibold">Level {w.level()} · {credits(w.credits())}</span>
                <span className={`text-[11px] ${t.muted}`}>Your civic credits</span>
              </div>
              {!owned && <p className={`mt-2 text-[11px] leading-snug ${t.muted}`} data-also>Also sold at {SHOP_INFO.designHouse.name}</p>}
            </div>

            <p className={`min-h-[1.25rem] px-5 text-[12px] ${t.muted}`} role="status" aria-live="polite" data-said>{said.home === home ? said.text : ''}</p>
          </>
        )}
        {furnishing ? (
          <div className={`px-5 py-3 text-[11px] ${t.muted}`} data-saved>Saved in this browser · Esc or B to finish</div>
        ) : (
          <div className={`flex items-center justify-between gap-2 border-t px-5 py-3 ${t.rule}`}>
            <span className={`text-[11px] ${t.muted}`}>Esc or B closes</span>
            <button type="button" onClick={onClose} className={`${BUTTON} px-5 font-semibold ${t.primary}`} data-action="done" data-touch>Done</button>
          </div>
        )}
      </aside>
    </div>
  )
}
