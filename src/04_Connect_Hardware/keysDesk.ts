// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the on-screen keys' mind, with the page held at arm's length so a Node test can
 * run it (ScreenKeys.tsx is its eyes and hands). It follows the field that has the caret, and remembers it while a
 * key has the focus or a card swaps one field for another; it decides with keyboardSense.ts whether the keys serve
 * that field and whether they stand open, offered as a chip, or away; it turns a press of a key (a finger, a click, a
 * pad's button, a single switch) into strokes for the field through textEntry.ts, one stroke per task so a page that
 * answers a key by redrawing its field has redrawn it before the next; and it holds the board's own state (layer,
 * Shift, Ctrl, the pad's highlight). It marks the field it serves so the device's own keyboard does not rise over
 * ours, gives the marks back when it stops, and lends player 1's pads to the keys only while they stand open, so the
 * button that types a letter does not also open a car door.
 * What breaks if it is removed? The keys have nothing behind them: no field to type into, no rule for when to show,
 * no pad to type with.
 */
import { boardFor, cursorOn, fitCursor, keyAt, keysOf, KEYS_START, nextAccent, pressKey, stepCursor, type Board, type Cursor, type KeyDef, type KeysState, type Layer, type PlacedKey } from './keyLayout.ts'
import { changeBefore, insertText, isCodeField, isLiveField, isTextField, strokeDown, strokeUp, type EntryEnv, type FieldLike, type KeyStroke } from './textEntry.ts'
import { insideKeys, keysServe, keysStand, type KeysFacts, type KeysSetting, type KeysStand, type LastDevice } from './keyboardSense.ts'
import type { PadAsk } from './keysPad.ts'

export const DESK = Object.freeze({
  /** A field that takes the focus this soon after a press on the page was asked for (a tap on the console). */
  solicitMs: 800,
  /** A field that takes the focus this soon after the keys were summoned (the pad menu's Keyboard, the console it opens) gets them open. */
  summonMs: 1500,
  /** The focus may be away from the field this long (a card swapping one field for another) before the keys let it go. */
  graceMs: 150,
  /** A field the same card focuses this soon after its last one keeps the keys as they were (open stays open). */
  stickyMs: 1000,
  /** A held key (Backspace, an arrow) acts again after this long, then this often, ms. */
  delayMs: 380,
  rateMs: 60,
  /** A field marked for a press that never focused it gets its marks back after this long. */
  premarkMs: 1000,
  /** A field given the focus back this soon after it lost it (the pad's menu closed) is as it was, open or offered. */
  returnMs: 30_000,
})

/** What the desk needs of the page. */
export interface DeskEnv {
  /** Stroke delivery (textEntry.ts browserEntryEnv). */
  readonly entry: EntryEnv
  now(): number
  /** Runs `fn` after `ms`; returns its cancelling. */
  timer(fn: () => void, ms: number): () => void
  /** The element with the focus. */
  active(): unknown
  /** The card a field stands in (Tab stays inside it, and a field it swaps for another keeps the keys as they were). */
  scopeOf(field: FieldLike): unknown
  /** The next field in that card after `field` (or before it), null when there is none. */
  nextField(field: FieldLike, back: boolean): FieldLike | null
  /** The first field shown, for keys summoned with no field focused. */
  firstField(): FieldLike | null
  focus(field: FieldLike): void
  /** Whether the pointer rests on the field (a dwell user's focus is their own). */
  hovered(field: FieldLike): boolean
  /** Whether `target` is inside the field's own box (its dialog or form): a finger there means to type in the field. */
  around(field: FieldLike, target: unknown): boolean
  /** Marks a field so the device's own keyboard stays down (on), or gives its own attributes back (off). */
  mark(field: FieldLike, on: boolean): void
  /** Hands the field to the device's own keyboard; called inside the press that asked, which a browser needs. */
  showSystem(field: FieldLike): void
  /** Lends player 1's pads to the keys, or takes them back. */
  lend(on: boolean): void
  /** Opens the console where a city runs; false where none does. */
  openConsole(): boolean
  readClip(): Promise<string> | null
  writeClip(text: string): Promise<void> | null
  /** Says a line to a screen reader. */
  say(text: string): void
}

/** What the desk needs of keyboardSense.ts KeyboardSense. */
export interface SenseLike {
  readonly last: LastDevice | null
  readonly pointerAt: number
  facts(setting: KeysSetting, codeField: boolean, hands: { scan?: boolean; dwell?: boolean }): KeysFacts
}

/** The player's settings that bear on the keys (access.ts) and what the device offers. */
export interface DeskHands {
  readonly setting: KeysSetting
  readonly scan: boolean
  readonly dwell: boolean
  /** The device has a keyboard of its own the keys can hand a field to (a touch-first device). */
  readonly system: boolean
}

export const DESK_HANDS: DeskHands = Object.freeze({ setting: 'auto', scan: false, dwell: false, system: false })

/** What the overlay draws. */
export interface DeskView {
  readonly mode: KeysStand
  readonly field: FieldLike | null
  readonly board: Board
  readonly keys: KeysState
  /** The key under the highlight while a pad or a headset drives; null otherwise. */
  readonly at: string | null
  /** The held key (Backspace, an arrow) while a finger or a click holds it. */
  readonly held: string | null
  /** A pad or a headset drives: the highlight and the legend show. */
  readonly pad: boolean
}

const LAYERS: readonly Layer[] = ['letters', 'numbers', 'symbols']
const SHIFT_KEY: KeyDef = Object.freeze({ id: 'shift', kind: 'shift', w: 3, label: '', say: 'Shift' })

interface Left { readonly at: number; readonly scope: unknown; readonly wanted: boolean; readonly summoned: boolean }

export class KeysDesk {
  private readonly env: DeskEnv
  private readonly sense: SenseLike
  private readonly listeners = new Set<() => void>()
  private view: DeskView
  private field: FieldLike | null = null
  private scope: unknown = null
  private wanted = false
  private summonedFor: FieldLike | null = null
  /** When a pad's button (or a headset's controller) last went down, on the env's clock; -Infinity before any. */
  private padAt = -Infinity
  private summonAt = -Infinity
  private readonly yielded = new WeakSet<object>()
  private left: Left | null = null
  /** The field the keys last followed, after it lost the focus (to the pad's menu, say): summoned, they go back to it. */
  private lastField: FieldLike | null = null
  /** Whether the keys stood open for it, and when it lost the focus. */
  private lastWanted = false
  private lastAt = -Infinity
  private keys: KeysState = KEYS_START
  private cursor: Cursor | null = null
  private heldKey: { id: string; stroke: KeyStroke; field: FieldLike | null } | null = null
  private hands: DeskHands = DESK_HANDS
  private blocked = false
  private marked: FieldLike | null = null
  private premarked: { readonly field: FieldLike; stop: () => void } | null = null
  private lent = false
  private leaving: (() => void) | null = null
  private repeat: (() => void) | null = null
  private readonly queue: (() => void)[] = []
  private busy = false
  private board: Board
  private boardKey = ''
  private disposed = false

  constructor(env: DeskEnv, sense: SenseLike) {
    this.env = env
    this.sense = sense
    this.board = boardFor({ layer: 'letters', shift: 'off', system: false, enter: '' })
    this.view = Object.freeze({ mode: 'hidden', field: null, board: this.board, keys: this.keys, at: null, held: null, pad: false })
  }

  // ---- what the overlay reads (the shape of React's useSyncExternalStore) ------------------------------------------

  get = (): DeskView => this.view
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  // ---- what the page tells it --------------------------------------------------------------------------------------

  setHands(hands: DeskHands): void {
    this.hands = hands
    this.refresh()
  }

  setBlocked(blocked: boolean): void {
    this.blocked = blocked
    this.refresh()
  }

  /** The focus went to `target` (a focusin anywhere on the page). */
  focusIn(target: unknown): void {
    if (insideKeys(target)) { this.stopLeaving(); return }
    if (!isTextField(target)) { this.leaveSoon(); return }
    const field = target as FieldLike
    this.stopLeaving()
    if (field === this.field) { this.refresh(); return }
    const now = this.env.now()
    const scope = this.env.scopeOf(field)
    const was: Left | null = this.left ?? (this.field ? { at: now, scope: this.scope, wanted: this.wanted, summoned: this.summonedFor === this.field } : null)
    // The press that marked this field has focused it: the marks stay on if the keys serve it, and come off if not.
    const pre = this.premarked?.field === field ? this.premarked : null
    if (pre) { pre.stop(); this.premarked = null }
    this.field = field
    this.scope = scope
    this.left = null
    const sticky = was !== null && now - was.at <= DESK.stickyMs && scope !== null && was.scope === scope
    const summoned = now - this.summonAt <= DESK.summonMs
    // A pad's press that opened the console (the card's button, the pad's menu): the prompt is what the press was for,
    // and a pad has nothing else to type on there. A card that focuses its own field is only offered (the chip).
    // The field given the focus back soon after it lost it (the pad's menu closing) is as it was, open or offered.
    const back = field === this.lastField && now - this.lastAt <= DESK.returnMs
    const padOpened = !back && (this.sense.last === 'gamepad' || this.sense.last === 'headset') && now - this.padAt <= DESK.summonMs
      && isCodeField(field as { getAttribute?(n: string): string | null })
    // Asked for: a press on the page just before (a tap on the console), the keys summoned, a dwell resting on the field.
    const asked = now - this.sense.pointerAt <= DESK.solicitMs || summoned || padOpened || (this.hands.dwell && this.env.hovered(field))
    this.summonedFor = summoned || (sticky && was.summoned) ? field : null
    // Asked for a field the keys do not serve (a mouse's click, a tap on a chat line) is not kept: a pad picked up
    // later offers them on the chip, as for any field.
    this.wanted = (asked || (sticky && was.wanted) || (back && this.lastWanted)) && this.serves(field)
    if (summoned) this.summonAt = -Infinity
    this.keys = KEYS_START
    this.refresh()
    if (pre && this.marked !== field) this.env.mark(field, false)
  }

  /** The focus left `target` for `related` (a focusout). */
  focusOut(target: unknown, related: unknown): void {
    if (target !== this.field || insideKeys(related)) return
    this.leaveSoon()
  }

  /**
   * A press on the page (a pointerdown, at the capture phase): a press on the field the keys serve asks for them again;
   * a press on a field they will serve marks it before it takes the focus, so the device's own keyboard does not rise.
   * The marks last while the press is held and premarkMs after it lets go (pointerUp), a second press starting again.
   */
  pointerDown(target: unknown): void {
    if (insideKeys(target) || !isTextField(target)) return
    const field = target as FieldLike
    if (field === this.field) {
      if (this.serves(field)) { this.wanted = true; this.refresh() }
      return
    }
    if (!this.serves(field)) return
    const p = this.premarked
    if (p?.field === field) { p.stop(); p.stop = this.env.timer(() => { if (this.premarked === p) this.unpremark() }, DESK.premarkMs * 5); return }
    this.unpremark()
    this.env.mark(field, true)
    const mark = { field, stop: (): void => {} }
    // A press held long (a finger resting before it lifts) keeps the marks; a press that never lets go gives them back.
    mark.stop = this.env.timer(() => { if (this.premarked === mark) this.unpremark() }, DESK.premarkMs * 5)
    this.premarked = mark
  }

  /** A press let go (a pointerup or pointercancel, at the capture phase): a field it marked keeps the marks premarkMs more. */
  pointerUp(): void {
    const p = this.premarked
    if (!p) return
    p.stop()
    p.stop = this.env.timer(() => { if (this.premarked === p) this.unpremark() }, DESK.premarkMs)
  }

  /**
   * A tap on the page (a touch or a pen that went down and up without moving): a tap anywhere in the dialog or form of
   * the field the keys serve (the console's lines, beside its prompt) asks for them again. A swipe through the
   * console's lines to read them is no tap, and asks nothing.
   */
  tap(target: unknown, pointerType: string): void {
    const f = this.field
    if (!f || insideKeys(target) || isTextField(target) || (pointerType !== 'touch' && pointerType !== 'pen')) return
    if (this.serves(f) && this.env.around(f, target)) { this.wanted = true; this.refresh() }
  }

  /** A field marked for a press that has not focused it gets its marks back. */
  private unpremark(): void {
    const p = this.premarked
    if (!p) return
    this.premarked = null
    p.stop()
    if (this.marked !== p.field) this.env.mark(p.field, false)
  }

  /** A pad's button went down (or a headset's controller acted): the press a field focused next may be asking for the keys. */
  padPressed(): void {
    this.padAt = this.env.now()
  }

  /**
   * The device in use changed (the watcher's onChange). A real keyboard's key puts the keys away even where they were
   * asked for: the player has a keyboard under their hands, and a pad's select asks again.
   */
  deviceChanged(): void {
    if (this.sense.last === 'keyboard') { this.wanted = false; this.summonedFor = null; this.left = null }
    this.refresh()
  }

  /** The single switch was pressed with the field offered: the scanning player asks for the keys. */
  switchOn(target: unknown): void {
    if (!this.hands.scan || target !== this.field || this.field === null) return
    this.wanted = true
    this.refresh()
  }

  /**
   * Asks for the keys (a pad's select button, the pad menu's Keyboard): on the field that has the caret, else the first
   * field shown, else the console's prompt (the console is opened). Open already, they are put away.
   */
  summon(): void {
    if (this.view.mode === 'open') { this.wanted = false; this.refresh(); return }
    // Off is never on screen; a card that must be answered first keeps the pads and the screen.
    if (this.hands.setting === 'off' || this.blocked) return
    const f = this.field && isLiveField(this.field) ? this.field : null
    if (f) {
      this.summonedFor = f
      this.yielded.delete(f)
      this.wanted = true
      this.refresh()
      return
    }
    this.summonAt = this.env.now()
    const active = this.env.active()
    if (isLiveField(active)) { this.focusIn(active); return }
    // The field the player was in before the pad's menu took the focus.
    const last = this.lastField && isLiveField(this.lastField) ? this.lastField : null
    if (last) {
      this.env.focus(last)
      if (this.field !== last) this.focusIn(last)
      return
    }
    const first = this.env.firstField()
    if (first) {
      this.env.focus(first)
      if (this.field !== first) this.focusIn(first)
      return
    }
    if (!this.env.openConsole()) this.summonAt = -Infinity
  }

  /** A field a card is about to focus is asked for (keysHost.ts expectKeys): it gets the keys open when it takes the focus. */
  expect(): void {
    this.summonAt = this.env.now()
  }

  /** Looks again at everything a decision rests on (the device in use changed, a frame passed). */
  refresh(): void {
    if (this.disposed) return
    let f = this.field
    if (f && !isLiveField(f)) { this.drop(); f = null }
    const serve = f !== null && this.serves(f)
    const mode = keysStand({ field: f !== null, serve, yielded: f !== null && this.yielded.has(f), wanted: this.wanted, blocked: this.blocked })
    // The marks keep the device's keyboard down while ours serve the field (open or offered).
    const markFor = mode === 'hidden' ? null : f
    if (this.marked !== markFor) {
      if (this.marked && this.marked !== this.premarked?.field) this.env.mark(this.marked, false)
      if (markFor) this.env.mark(markFor, true)
      this.marked = markFor
    }
    const enter = f ? ((f as { getAttribute?(n: string): string | null }).getAttribute?.('enterkeyhint') ?? '') : ''
    const boardKey = `${this.keys.layer}|${this.keys.shift}|${this.hands.system}|${enter}`
    if (boardKey !== this.boardKey) {
      this.boardKey = boardKey
      this.board = boardFor({ layer: this.keys.layer, shift: this.keys.shift, system: this.hands.system, enter })
      if (this.cursor) this.cursor = fitCursor(this.board, this.cursor)
    }
    const open = mode === 'open'
    if (open !== this.lent) {
      this.lent = open
      if (open) this.cursor = this.home()
      else this.stopHold()
      this.env.lend(open)
    }
    const pad = this.sense.last === 'gamepad' || this.sense.last === 'headset'
    const at = open && pad && this.cursor ? keyAt(this.board, this.cursor).id : null
    const held = this.heldKey?.id ?? null
    const v = this.view
    if (v.mode === mode && v.field === f && v.board === this.board && v.keys === this.keys && v.at === at && v.held === held && v.pad === pad) return
    this.view = Object.freeze({ mode, field: f, board: this.board, keys: this.keys, at, held, pad })
    for (const l of [...this.listeners]) l()
  }

  // ---- presses -----------------------------------------------------------------------------------------------------

  /** A key pressed and let go (a finger lifted on it, a click, a switch, a pad's south button). */
  press(id: string): void {
    const key = this.keyById(id)
    if (key) this.pressDef(key)
  }

  /** A key that acts on press and again while held (Backspace, an arrow): down. */
  holdStart(id: string): void {
    const key = this.keyById(id)
    if (!key || !key.held || !this.field) return
    this.stopHold()
    const r = pressKey(this.keys, key)
    this.keys = r.state
    if (r.out?.kind !== 'stroke') { this.refresh(); return }
    const stroke = r.out.stroke
    const hold = { id, stroke, field: null as FieldLike | null }
    this.heldKey = hold
    this.enqueue(() => { hold.field = this.down(stroke, false) })
    const again = (ms: number): void => {
      this.repeat = this.env.timer(() => {
        if (this.heldKey !== hold) return
        this.enqueue(() => { const f = this.down(stroke, true); if (f) hold.field = f })
        again(DESK.rateMs)
      }, ms)
    }
    again(DESK.delayMs)
    this.refresh()
  }

  /** The held key let go. */
  holdEnd(id: string): void {
    if (this.heldKey?.id !== id) return
    this.stopHold()
    this.refresh()
  }

  /** What the pad asks while the keys are open (keysPad.ts). */
  padAsk(ask: PadAsk): void {
    if (this.view.mode !== 'open') return
    const board = this.board
    const cursor = this.cursor ?? this.home()
    switch (ask.control) {
      case 'up': case 'down': case 'left': case 'right': {
        if (!cursor) return
        this.cursor = stepCursor(board, cursor, ask.control)
        this.env.say(keyAt(board, this.cursor).say)
        this.refresh()
        return
      }
      case 'press': {
        if (!cursor) return
        const key = keyAt(board, cursor)
        // A held button types its letter again, as a held key does; it does not flip Shift or the layer on and off.
        if (ask.repeat && key.kind !== 'char' && key.kind !== 'named') return
        // A browser raises its own keyboard only inside a person's own press, and a pad's button is none.
        if (key.kind === 'system') { this.env.say('The device\'s own keyboard opens from a tap on this key'); return }
        this.pressDef(key)
        return
      }
      case 'back': return this.pressId('Backspace')
      case 'space': return this.pressId('space')
      case 'caretLeft': return this.pressId('ArrowLeft')
      case 'caretRight': return this.pressId('ArrowRight')
      case 'enter': return this.pressId('Enter')
      case 'shift': this.pressDef(this.keyById('shift') ?? SHIFT_KEY); return
      case 'layer': {
        const to = LAYERS[(LAYERS.indexOf(this.keys.layer) + 1) % LAYERS.length]
        this.pressDef({ id: `layer:${to}`, kind: 'layer', to, w: 3, label: '', say: to })
        return
      }
      case 'close':
        this.wanted = false
        this.refresh()
    }
  }

  /** Lets go of the page: timers, marks, the pads. */
  dispose(): void {
    this.stopHold()
    this.stopLeaving()
    this.unpremark()
    if (this.marked) this.env.mark(this.marked, false)
    this.marked = null
    if (this.lent) this.env.lend(false)
    this.lent = false
    this.disposed = true
    this.listeners.clear()
  }

  // ---- inside --------------------------------------------------------------------------------------------------------

  /** Whether the keys serve a field: the policy, or the player summoned them for it, and it was not handed to the device's keyboard. */
  private serves(field: FieldLike): boolean {
    if (this.yielded.has(field) || this.hands.setting === 'off') return false
    if (this.summonedFor === field) return true
    return keysServe(this.sense.facts(this.hands.setting, isCodeField(field as { getAttribute?(n: string): string | null }), this.hands))
  }

  /** Where the pad's highlight starts: on g, in the middle of the letters; on another board, its first key. */
  private home(): Cursor {
    return cursorOn(this.board, 'g') ?? fitCursor(this.board, { row: 0, index: 0, x: 0 })
  }

  private keyById(id: string): PlacedKey | null {
    return keysOf(this.board).find((k) => k.id === id) ?? null
  }

  private pressId(id: string): void {
    const key = this.keyById(id)
    if (key) this.pressDef(key)
  }

  private pressDef(key: KeyDef): void {
    if (!this.field) return
    const r = pressKey(this.keys, key)
    this.keys = r.state
    const out = r.out
    if (out) {
      switch (out.kind) {
        case 'stroke': {
          const stroke = out.stroke
          this.enqueue(() => {
            const f = this.down(stroke, false)
            if (f) this.env.entry.later(() => strokeUp(f, stroke, this.env.entry))
          })
          break
        }
        case 'accent':
          this.enqueue(() => { const f = this.liveField(); if (f) changeBefore(f, this.env.entry, nextAccent) })
          break
        case 'paste':
          this.paste()
          break
        case 'hide':
          this.wanted = false
          break
        case 'system': {
          // Inside the press: a browser raises its own keyboard only for a focus a person's gesture made.
          const f = this.liveField()
          if (f) {
            this.yielded.add(f)
            this.wanted = false
            this.refresh()
            this.env.showSystem(f)
          }
          break
        }
      }
    }
    this.refresh()
  }

  /** The first half of a stroke into the field; returns the field its keyup belongs to (null: nothing went). */
  private down(stroke: KeyStroke, repeat: boolean): FieldLike | null {
    const f = this.liveField()
    if (!f) return null
    const d = strokeDown(f, stroke, this.env.entry, repeat)
    if (d.result === 'tab') {
      const next = this.env.nextField(d.field, stroke.shift === true)
      if (next) this.env.focus(next)
    } else if (d.result === 'none' && stroke.ctrl) this.clip(d.field, stroke.key)
    return d.field
  }

  /** Ctrl+C and Ctrl+X the page left alone: the selection to the clipboard (a password's never), and cut from the field. */
  private clip(f: FieldLike, key: string): void {
    const k = key.toLowerCase()
    if (k !== 'c' && k !== 'x') return
    const a = f.selectionStart, b = f.selectionEnd
    if (a === null || b === null || a === b || (f.type ?? '').toLowerCase() === 'password') return
    const p = this.env.writeClip(f.value.slice(Math.min(a, b), Math.max(a, b)))
    if (!p) { this.env.say(k === 'x' ? 'Cutting is not allowed here' : 'Copying is not allowed here'); return }
    if (k === 'c') { p.catch(() => this.env.say('The clipboard could not be written')); return }
    // Cut only once the text is on the clipboard, and only what is still selected: a refused write loses nothing.
    const value = f.value
    p.then(
      () => this.enqueue(() => {
        if (this.liveField() === f && f.value === value && f.selectionStart === a && f.selectionEnd === b) insertText(f, '', this.env.entry, 'deleteByCut')
      }),
      () => this.env.say('The clipboard could not be written, so nothing was cut'),
    )
  }

  private paste(): void {
    const p = this.env.readClip()
    if (!p) { this.env.say('Pasting is not allowed here'); return }
    p.then(
      (text) => { if (text) this.enqueue(() => { const f = this.liveField(); if (f) insertText(f, text, this.env.entry, 'insertFromPaste') }) },
      () => this.env.say('The clipboard could not be read'),
    )
  }

  private liveField(): FieldLike | null {
    const f = this.field
    if (f && isLiveField(f)) return f
    if (f) { this.drop(); this.refresh() }
    return null
  }

  /** One stroke per task: the first goes now (a finger's lift keeps its permission for what it asked), the rest each in a task of its own. */
  private enqueue(job: () => void): void {
    if (this.busy) { this.queue.push(job); return }
    this.busy = true
    this.run(job)
  }

  private run(job: () => void): void {
    try { job() } finally {
      this.env.timer(() => {
        const next = this.queue.shift()
        if (next && !this.disposed) this.run(next)
        else { this.busy = false; this.queue.length = 0 }
      }, 0)
    }
  }

  private stopHold(): void {
    this.repeat?.()
    this.repeat = null
    const hold = this.heldKey
    if (!hold) return
    this.heldKey = null
    this.enqueue(() => { if (hold.field) strokeUp(hold.field, hold.stroke, this.env.entry) })
  }

  private leaveSoon(): void {
    if (!this.field || this.leaving) return
    this.leaving = this.env.timer(() => {
      this.leaving = null
      const f = this.field
      if (!f) return
      const a = this.env.active()
      if (a === f || insideKeys(a)) return
      // A scanning player's focus goes round the page's controls: the field is kept while it is shown.
      if (this.hands.scan && isLiveField(f)) return
      this.left = { at: this.env.now(), scope: this.scope, wanted: this.wanted, summoned: this.summonedFor === f }
      this.drop()
      this.refresh()
    }, DESK.graceMs)
  }

  private stopLeaving(): void {
    this.leaving?.()
    this.leaving = null
  }

  /** Forgets the field (refresh gives its marks back). */
  private drop(): void {
    // A field handed to the device's keyboard is handed over for as long as it keeps the caret, not for good.
    if (this.field) {
      this.yielded.delete(this.field)
      this.lastField = this.field
      this.lastWanted = this.wanted
      this.lastAt = this.env.now()
    }
    this.field = null
    this.scope = null
    this.wanted = false
    this.summonedFor = null
    this.stopLeaving()
  }
}
