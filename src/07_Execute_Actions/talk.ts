// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the conversation with the person near the player: when it starts and ends, where
 * each reply comes from, how it is said, and where the label over their head stands. No state here is without a way
 * out. It has four parts.
 * - The link. Every TALK_SCAN_MS the controller asks the engine (TalkHost.scan) who is near and how the person it
 *   already follows stands, and feeds that to the pure reducer (08_Swarm/talkLink.ts linkStep). The reducer decides
 *   who is offered (near) and when an open conversation closes (walked on, gone, behind a wall). The controller
 *   tells the engine which row to follow, only when that row changes. Talking is blocked while the player drives,
 *   wears a headset, has a card, the console or Sloane's card open, or hides the HUD (setBlocked and
 *   TalkHost.blocked), and an open conversation then closes as 'away'.
 * - The start and the end. A conversation opens on purpose only: T, the pad's talk button, a tap on the chip (with
 *   the serial of the proposal it showed, so a stale chip never opens the wrong person), or a spoken greeting to the
 *   person offered (talkLines.ts greets). It closes on Done, Esc, the pad's button again, a goodbye, a line said to
 *   Sloane (which goes on to her), the link's own reasons, 60 s with nothing going on, or dispose. The staring setter
 *   (the partner option) is told only from #link on opening and #unlink on closing, never per tick and never for a
 *   person only offered.
 * - The reply. Each player line is one turn. A goodbye, thanks and words the 14A screen refuses take the script at
 *   once (talkLines.ts lineFor). Everything else asks the page's model through PersonChat (onboarding/voice.ts
 *   personChat), which answers `none` at once when the model is not warm and cheap enough for a passer-by. One
 *   request at a time is owned here (#ask), and patience is kept here, never in voice.ts. A request queued behind
 *   Sloane's (WAITING_PHASE) is stopped at once and the script answers. With no first words within PATIENCE_MS, the
 *   script answers now, and a request still loading or reading the prompt is not stopped then (stopping the model in
 *   this page mid-load unloads it). It is marked late instead, and it stops itself at its first words or once it has
 *   to wait. Its words never reach the screen. A reply that would read as a recruitment request is replaced by a
 *   script line before it is shown or said, because the browser's recogniser could hear it come back through the
 *   speakers. Any other failure (held, none, slow, failed) takes the script line for what the player asked.
 * - The voice and the label. Each reply is said through Sloane's own speaker (ConciergeSpeaker.person), so one mouth
 *   carries both, and the microphone's echo guard and barge-in cover people too. A hired agent with a provider voice
 *   is heard at their head, and everyone else in a browser voice of their own, quieter with distance, with a wordless
 *   caption saying where. A device with no voice shows the text and holds the turn for a reading time. The label
 *   over the head is written straight to its element's transform in tick, outside React, and only when it moves by
 *   more than half a pixel. The panel, the label and the HUD's chip read the frozen snapshots ui() and hud(), which
 *   change only on an edge.
 * Every timer goes through the injectable clock, so a test can see that none is left after an ending or dispose.
 * What breaks if it is removed? The label, the chip and the conversation panel have nothing behind them: nobody in
 * the street can be talked to.
 */
import { mix, parseRequest } from '../03_Spawn_Agents/skills.ts'
import { contextLines } from '../08_Swarm/shortTerm.ts'
import type { AgentContext } from '../08_Swarm/shortTerm.ts'
import { blankScan, LINK_OFF, linkStep, TALK_RUN, TALK_SCAN_MS, type TalkEnd, type TalkEye, type TalkLink, type TalkScan } from '../08_Swarm/talkLink.ts'
import { ABOUT_MAX, greets, intentOf, lineFor, openerFor, personPrompt, type Intent, type TalkWho } from '../08_Swarm/talkLines.ts'
import { bearing, type Bearing, type ListenerPose } from './captions.ts'
import { addressesSloane, HEARD_MAX } from './onboarding/heard.ts'
import type { ConciergeOut, ConciergeSpeaker, PersonVoice } from './onboarding/speaker.ts'
import { PERSON_TURNS, phaseLine, type ChatResult, type PersonChat, type PersonTurn } from './onboarding/voice.ts'
import type { ScreenPoint } from './screenPoint.ts'

export type { TalkEnd, TalkEye, TalkScan } from '../08_Swarm/talkLink.ts'

/** How long a model has to give its first words before the script answers, ms. */
export const PATIENCE_MS = 5000
/** The shortest beat before a scripted line is said, ms: a person takes a moment to answer. */
export const BEAT_MIN_MS = 350
/** The beat is BEAT_MIN_MS plus up to this much, fixed per person and turn, ms. */
export const BEAT_SPAN_MS = 400
/** A line no voice can say is held as said for this long per character, ms, between READ_MIN_MS and READ_MAX_MS. */
export const READ_MS_PER_CHAR = 55
export const READ_MIN_MS = 1200
export const READ_MAX_MS = 5000
/** An open conversation with nothing going on for this long closes ('idle'), ms. */
export const IDLE_MS = 60000
/** 'Nobody close enough' is said at most this often, ms. */
export const NOBODY_TOAST_MS = 5000
/** The transcript keeps this many lines. */
export const TRANSCRIPT_LINES = 8
/**
 * The phase the model in this page reports while another answer holds it (09_Cognition/inPage.ts WAITING, pinned
 * equal by a test): a person's request would wait behind Sloane's, so it is stopped and the script answers.
 */
export const WAITING_PHASE = 'waiting for the model to finish another answer'
/** What a press with nobody near says. */
export const NOBODY_LINE = 'Nobody close enough to talk to. Walk up to someone.'

/** How a conversation was asked for: T, the pad's talk button, or a tap on the chip. */
export type TalkHow = 'keyboard' | 'pad' | 'tap'
/** What the person does in an open conversation: listening to the player, thinking of a reply, or saying it. */
export type TalkTurn = 'listening' | 'thinking' | 'speaking'

/**
 * What the controller needs of the city (Engine.talkHost(), frozen). `agents` is how many crowd rows there are.
 * `blocked` says why talking is not possible now, or null. `eye` is where the player stands (a reused record: read
 * at once). `scan` fills `out` with the nominee and the measures of the row `current` (−1 for none). `follow` tells
 * which row the label and a provider voice follow (−1 for none). `place` is where the label's anchor falls on the
 * screen this frame (NaN both ways when it is not drawn). `context` is what is known about a person, for the prompt.
 * `out` is where a hired agent's provider voice is heard (at their head). `caption` starts and stops the wordless
 * caption of a browser voice. `hour` is the city's clock hour for the opener; without it the opener is a day one.
 */
export interface TalkHost {
  readonly agents: number
  blocked(): 'car' | 'away' | 'halted' | null
  eye(): TalkEye
  scan(current: number, out: TalkScan): void
  follow(row: number): void
  place(): ScreenPoint
  context(row: number): AgentContext | null
  out(row: number, label: string): ConciergeOut
  caption(row: number, label: string, on: boolean): void
  hour?(): number
}

/** The controller's time and timers: the page's own by default, a test's fake when given. */
export interface TalkClock {
  now(): number
  after(ms: number, fn: () => void): unknown
  cancel(handle: unknown): void
}

/** The label's element as tick writes it: its transform and visibility, nothing read back. */
export interface TalkLabelEl {
  readonly style: { transform: string; visibility: string }
}

/**
 * What the controller is built with. `who` says who a row is (talkLines.ts talkWho over the roster and the
 * recruiter). `partner` is the staring setter, told the row on opening and null on closing. `onOpen` is told as a
 * conversation opens and closes. `onSloane` takes a typed line said to Sloane. `toast` says an ending the player did
 * not choose. `micOpen` says whether a microphone is open (a pad opening then asks for no focus, so a virtual keyboard
 * does not cover the screen while the player speaks).
 */
export interface TalkOptions {
  host: TalkHost
  chat: PersonChat
  speaker: Pick<ConciergeSpeaker, 'person' | 'stop'>
  who(row: number): TalkWho
  partner(row: number | null): void
  onOpen(on: boolean): void
  onSloane(text: string): void
  toast(title: string, body: string): void
  micOpen?(): boolean
  clock?: TalkClock
}

/** One line of the transcript: the player's (`you`) or the person's (`them`), `live` while a model reply streams in. */
export interface TalkLine {
  readonly id: number
  readonly who: 'you' | 'them'
  readonly text: string
  readonly live: boolean
}

/**
 * What the label and the panel show, frozen and new only on an edge. `state` is nobody, someone offered, or a
 * conversation; `turn` is null unless open. `who` is the person offered or talked with. `serial` names the proposal
 * (the chip hands it back on a tap). `lines` is the transcript, at most TRANSCRIPT_LINES, oldest first. `status` is the
 * panel's small line. `focus` counts the requests to focus the field. `said` is the line for the screen reader's
 * polite status, new each time `saidId` changes. `preview` is true for the debug partner (preview()).
 */
export interface TalkUi {
  readonly state: 'off' | 'near' | 'open'
  readonly turn: TalkTurn | null
  readonly who: TalkWho | null
  readonly serial: number
  readonly lines: readonly TalkLine[]
  readonly status: string
  readonly focus: number
  readonly said: string
  readonly saidId: number
  readonly preview: boolean
}

/**
 * What the HUD's chip and the announcer read (telemetry.ts HudTalk), at its 10 Hz tick: the state, the proposal's
 * serial, the person's label and line, and where they stand from the player (captions.ts bearing: an arrow, a word,
 * rounded metres; '' and NaN while unknown). The same object comes back while nothing in it changed.
 */
export interface TalkHud {
  readonly state: 'near' | 'open' | 'thinking' | 'speaking'
  readonly serial: number
  readonly label: string
  readonly line: string
  readonly arrow: string
  readonly word: string
  readonly metres: number
}

/** A browser voice's loudness for a person `d` m away: 1.5/d, held between 0.35 and 1 (1 when the distance is unknown). */
export function voiceVolume(d: number): number {
  return Number.isFinite(d) && d > 0 ? Math.min(1, Math.max(0.35, 1.5 / d)) : 1
}

/** The row the debug partner is given, held inside the crowd. */
const PREVIEW_ROW = 1234
/** The status line while a reply is coming and while it is said. */
const THINKING = 'Thinking…'
const SPEAKING = 'Speaking'
/** The label stays this far inside the layer, px, and is moved only by more than MOVE_PX. */
const EDGE_PX = 8
const MOVE_PX = 0.5
/** What the toast says after the label for an ending the player did not choose. */
const LEFT: Partial<Record<TalkEnd, string>> = { walked: 'walked on.', gone: 'had to go.', idle: 'went back to their day.' }
/** The endings that cut a line still being said; the others let it finish. */
const CUTS: ReadonlySet<TalkEnd> = new Set<TalkEnd>(['done', 'away', 'sloane', 'dispose'])
const PRESS = Object.freeze({ e: 'press' as const })
const BLOCKED = Object.freeze({ e: 'blocked' as const })

/** The page's clock: its own times are compared only with each other (the frame's time drives the scans). */
const pageClock: TalkClock = {
  now: () => Date.now(),
  after: (ms, fn) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/** A heard or typed line as a turn: white space folded, at most HEARD_MAX characters. */
const fold = (text: string): string => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, HEARD_MAX)

/** One open conversation: who with, what was said, and where the person's turn stands. */
interface Conv {
  readonly row: number
  readonly who: TalkWho
  /** False for the debug partner: no link, no partner call, no caption. */
  readonly real: boolean
  readonly lines: TalkLine[]
  /** The turns the model is shown, at most PERSON_TURNS (a refused turn is left out). */
  readonly turns: PersonTurn[]
  /** The script lines said (talkLines.ts lineFor records them). */
  readonly used: Set<number>
  /** The player's turns so far. */
  n: number
  turn: TalkTurn
  status: string
  /** The id of the line a model reply streams into, −1 for none. */
  live: number
  /** The farewell is being said: the conversation closes when it ends. */
  closing: boolean
  /** When something last happened, and when the player's last turn began, on the controller's clock. */
  activeAt: number
  turnAt: number
  beat: number
}

/** The one request to the model: its stop, its turn, what was asked, its phase, and whether it was given up (late). */
interface Ask {
  readonly ctl: AbortController
  readonly id: number
  readonly intent: Intent
  phase: string | null
  streaming: boolean
  late: boolean
}

/** The conversation with the person near the player (see the file's header). */
export class TalkController {
  readonly #o: TalkOptions
  readonly #host: TalkHost
  readonly #clock: TalkClock
  readonly #subs = new Set<() => void>()
  readonly #scanOut: TalkScan = blankScan()
  readonly #pose: ListenerPose = { x: Number.NaN, z: Number.NaN, yaw: 0 }
  readonly #bear: Bearing = { hour: 0, arrow: '', word: '', metres: Number.NaN }
  #state: TalkLink = LINK_OFF
  /** The person offered or talked with (or the debug partner). */
  #who: TalkWho | null = null
  #conv: Conv | null = null
  #ask: Ask | null = null
  #preview: 'near' | 'open' | null = null
  #serial = 0
  #turnId = 0
  #lineId = 0
  #voiceId = 0
  /** A person's line is with the speaker and has not ended. */
  #voicing = false
  /** The row told to the staring setter (null for none), and the row the engine follows. */
  #partnered: number | null = null
  #followed = -1
  #blocked = false
  #disposed = false
  #draft = ''
  #focused = false
  #focus = 0
  #said = ''
  #saidId = 0
  #scanAt = -Infinity
  #nobodyAt = -Infinity
  #curD = Number.NaN
  #curX = Number.NaN
  #curZ = Number.NaN
  #beatT: unknown = null
  #patienceT: unknown = null
  #readT: unknown = null
  #el: TalkLabelEl | null = null
  #W = 0
  #H = 0
  #lw = 0
  #px = Number.NaN
  #py = Number.NaN
  #shown: boolean | null = null
  #ui: TalkUi
  #hud: TalkHud | undefined = undefined

  constructor(o: TalkOptions) {
    this.#o = o
    this.#host = o.host
    this.#clock = o.clock ?? pageClock
    this.#ui = this.#snapshot()
  }

  /**
   * Called every frame after the engine's: feeds 'blocked' while talking is not possible, scans every TALK_SCAN_MS
   * (`now` is the frame's time), closes a conversation idle for IDLE_MS, and moves the label.
   */
  tick(now: number): void {
    if (this.#disposed) return
    if (this.#preview === null) {
      if (this.#blocked || this.#host.blocked() !== null) this.#block()
      else if (!(now - this.#scanAt < TALK_SCAN_MS)) {
        this.#scanAt = now
        this.#scan(now)
      }
      const conv = this.#conv
      if (conv && this.#idle() && this.#clock.now() - conv.activeAt >= IDLE_MS) this.end('idle')
    }
    this.#place()
  }

  /**
   * T, the pad's talk button or a tap on the chip (with the serial it showed). Someone offered: the conversation
   * opens. Open: the pad's button closes it, T asks for the field's focus. Nobody near: T or the pad says so, at most
   * every NOBODY_TOAST_MS.
   */
  press(how: TalkHow, serial?: number): void {
    if (this.#disposed) return
    if (this.#conv) {
      if (how === 'pad') this.end('done')
      else if (how === 'keyboard') {
        this.#focus++
        this.#emit()
      }
      return
    }
    const who = this.#who
    if (this.#preview === 'near' && who) {
      if (how !== 'tap' || serial === this.#serial) this.#open(how, who.row, false)
      return
    }
    if (this.#blocked || this.#host.blocked() !== null) return
    const s = this.#state
    if (s.mode === 'near') {
      if (how === 'tap' && serial !== this.#serial) return
      this.#state = linkStep(s, PRESS).link
      this.#open(how, s.row, true)
      return
    }
    const now = this.#clock.now()
    if (how !== 'tap' && !(now - this.#nobodyAt < NOBODY_TOAST_MS)) {
      this.#nobodyAt = now
      this.#o.toast('Talk', NOBODY_LINE)
    }
  }

  /**
   * A line the microphone heard that is not a recruitment request. Open: a line said to Sloane closes the
   * conversation and is left for her (false); any other is the player's turn (true). Someone offered: a greeting to
   * them opens the conversation with it as the first turn (true). Anything else, or while blocked, is not taken.
   */
  hear(text: string): boolean {
    if (this.#disposed) return false
    const t = fold(text)
    if (!t || (this.#preview === null && (this.#blocked || this.#host.blocked() !== null))) return false
    const conv = this.#conv
    if (conv) {
      if (addressesSloane(t)) {
        this.end('sloane')
        return false
      }
      this.#reply(conv, t)
      return true
    }
    const who = this.#who
    if (!who || !(this.#state.mode === 'near' || this.#preview === 'near') || !greets(t, who)) return false
    const real = this.#preview === null
    if (real) this.#state = linkStep(this.#state, PRESS).link
    this.#reply(this.#open('voice', who.row, real), t)
    return true
  }

  /** A typed line: the player's turn ('sent'), nothing ('empty'), or no conversation to take it ('gone'; a line to Sloane goes to her). */
  send(text: string): 'sent' | 'gone' | 'empty' {
    const conv = this.#conv
    if (this.#disposed || !conv) return 'gone'
    const t = fold(text)
    if (!t) return 'empty'
    if (addressesSloane(t)) {
      this.end('sloane')
      this.#o.onSloane(t)
      return 'gone'
    }
    this.#reply(conv, t)
    return 'sent'
  }

  /** Closes the conversation for `why` (a person only offered is let go, with no reason told). */
  end(why: TalkEnd): void {
    if (this.#disposed) return
    const conv = this.#conv
    if (conv) {
      this.#close(why, conv.real ? linkStep(this.#state, { e: 'end', why }).link : LINK_OFF)
      return
    }
    if (this.#state.mode === 'off' && this.#preview === null) return
    this.#state = linkStep(this.#state, { e: 'end', why }).link
    this.#preview = null
    this.#who = null
    this.#follow()
    this.#emit()
  }

  /** The page's own reasons talking is not possible (a card, the console, Sloane's card, the HUD hidden). */
  setBlocked(on: boolean): void {
    if (this.#disposed) return
    this.#blocked = on === true
    if (this.#blocked && this.#preview === null) this.#block()
  }

  /** The panel's field: its text and whether it has focus (a conversation with either is not idle). */
  setDraft(text: string, focused: boolean): void {
    const draft = String(text ?? '')
    if (draft === this.#draft && focused === this.#focused) return
    this.#draft = draft
    this.#focused = focused === true
    if (this.#conv) this.#conv.activeAt = this.#clock.now()
  }

  /** The label's element (null when it unmounts). */
  attachLabel(el: TalkLabelEl | null): void {
    this.#el = el
    this.#shown = null
    this.#px = Number.NaN
  }

  /** The label layer's size, px. */
  setLayerSize(w: number, h: number): void {
    this.#W = Number.isFinite(w) ? w : 0
    this.#H = Number.isFinite(h) ? h : 0
    this.#px = Number.NaN
  }

  /** The label's width, px, measured once per change of its content. */
  setLabelWidth(w: number): void {
    this.#lw = Number.isFinite(w) ? Math.max(0, w) : 0
    this.#px = Number.NaN
  }

  /** Calls `fn` whenever ui() changes; returns the way to stop. */
  subscribe(fn: () => void): () => void {
    if (this.#disposed) return () => {}
    this.#subs.add(fn)
    return () => { this.#subs.delete(fn) }
  }

  ui(): TalkUi {
    return this.#ui
  }

  /** The chip's and the announcer's view, or undefined with nobody offered or talked with. */
  hud(): TalkHud | undefined {
    const who = this.#who
    if (this.#disposed || !who) return undefined
    const conv = this.#conv
    const state = !conv ? 'near' : conv.turn === 'listening' ? 'open' : conv.turn
    const b = bearing(this.#pose, this.#curX, this.#curZ, this.#bear)
    const h = this.#hud
    if (h && h.state === state && h.serial === this.#serial && h.label === who.label && h.line === who.line && h.arrow === b.arrow && h.word === b.word && Object.is(h.metres, b.metres)) return h
    this.#hud = Object.freeze({ state, serial: this.#serial, label: who.label, line: who.line, arrow: b.arrow, word: b.word, metres: b.metres })
    return this.#hud
  }

  /**
   * A debug partner for the smoke run (window.__SIM__.talk): 'near' offers them, 'open' opens a conversation with
   * them, null lets them go. No link, no partner call, no scan while it stands; the replies are real.
   */
  preview(state: 'near' | 'open' | null): void {
    if (this.#disposed) return
    if (this.#conv) this.end('done')
    this.#state = LINK_OFF
    this.#follow()
    this.#preview = state
    this.#who = state === null ? null : this.#o.who(Math.max(1, Math.min(PREVIEW_ROW, this.#host.agents - 1)))
    if (state !== null) this.#serial++
    if (state === 'open' && this.#who) this.#open('tap', this.#who.row, false)
    else this.#emit()
  }

  /** Closes everything ('dispose'), follows nobody, and makes every later call do nothing. Safe to call twice. */
  dispose(): void {
    if (this.#disposed) return
    this.end('dispose')
    this.#disposed = true
    this.#clearTimers()
    if (this.#ask) {
      this.#ask.ctl.abort()
      this.#ask = null
    }
    this.#state = LINK_OFF
    this.#who = null
    this.#preview = null
    try {
      this.#host.follow(-1)
    } catch {
      // a halted engine follows nobody already
    }
    this.#followed = -1
    if (this.#el) this.#el.style.visibility = 'hidden'
    this.#el = null
    this.#subs.clear()
    this.#ui = this.#snapshot()
  }

  /** The one place the staring setter hears of a partner. */
  #link(row: number): void {
    if (this.#partnered === row) return
    this.#partnered = row
    try { this.#o.partner(row) } catch { /* a head that cannot turn is not the conversation's failure */ }
  }

  /** The one place the staring setter is let go. */
  #unlink(): void {
    if (this.#partnered === null) return
    this.#partnered = null
    try { this.#o.partner(null) } catch { /* as in #link */ }
  }

  #idle(): boolean {
    const c = this.#conv
    return !c || (c.turn === 'listening' && !this.#draft && !this.#focused)
  }

  #scan(now: number): void {
    const s = this.#state
    const out = blankScan(this.#scanOut)
    this.#host.scan(s.mode === 'off' ? -1 : s.row, out)
    const eye = this.#host.eye()
    this.#pose.x = eye.x
    this.#pose.z = eye.z
    this.#pose.yaw = eye.yaw
    this.#curD = out.curD
    this.#curX = out.curX
    this.#curZ = out.curZ
    const step = linkStep(s, { e: 'scan', s: out, idle: this.#idle(), running: eye.speed > TALK_RUN, now })
    if (step.ended !== null) {
      this.#close(step.ended, step.link)
      return
    }
    const next = step.link
    this.#state = next
    let changed = false
    if (next.mode === 'near' && (s.mode !== 'near' || s.row !== next.row)) {
      this.#who = this.#o.who(next.row)
      this.#serial++
      changed = true
    } else if (next.mode === 'off' && this.#who !== null) {
      this.#who = null
      changed = true
    }
    this.#follow()
    if (changed) this.#emit()
  }

  /** Talking is blocked: the link goes off, and an open conversation closes as 'away'. */
  #block(): void {
    const s = this.#state
    if (this.#conv?.real) this.#close('away', linkStep(s, BLOCKED).link)
    else if (s.mode !== 'off' || s.pendN > 0) {
      this.#state = linkStep(s, BLOCKED).link
      this.#who = null
      this.#follow()
      this.#emit()
    }
  }

  /** Tells the engine the row to follow when it changes: the person offered or talked with, else −1. */
  #follow(): void {
    const s = this.#state
    const row = s.mode === 'off' ? -1 : s.row
    if (row === this.#followed) return
    this.#followed = row
    this.#host.follow(row)
  }

  /** Opens a conversation with `row` (`real` false for the debug partner); the opener is said unless it began by voice. */
  #open(how: TalkHow | 'voice', row: number, real: boolean): Conv {
    const who = this.#who ?? this.#o.who(row)
    const now = this.#clock.now()
    const conv: Conv = { row, who, real, lines: [], turns: [], used: new Set(), n: 0, turn: 'listening', status: '', live: -1, closing: false, activeAt: now, turnAt: now, beat: BEAT_MIN_MS }
    this.#who = who
    this.#conv = conv
    this.#draft = ''
    this.#focused = false
    this.#follow()
    if (real) this.#link(row)
    this.#o.onOpen(true)
    if (how === 'keyboard' || (how === 'pad' && !(this.#o.micOpen?.() ?? false))) this.#focus++
    const lead = `Talking to ${who.label}, ${who.skill} and ${who.skill2}. Speak or type; Escape to finish.`
    if (how === 'voice') {
      this.#announce(lead)
      this.#emit()
    } else this.#say(conv, openerFor(who, this.#host.hour?.() ?? Number.NaN), true, false, `${lead} `)
    return conv
  }

  /** One player turn: what was being said or asked gives way, and the reply comes from the script or the model. */
  #reply(conv: Conv, text: string): void {
    if (this.#voicing) this.#o.speaker.stop()
    this.#voicing = false
    this.#voiceId++
    this.#beatT = this.#cancel(this.#beatT)
    this.#readT = this.#cancel(this.#readT)
    this.#retire()
    this.#dropLive(conv)
    const id = ++this.#turnId
    const now = this.#clock.now()
    conv.n++
    conv.closing = false
    conv.activeAt = now
    conv.turnAt = now
    conv.beat = BEAT_MIN_MS + (mix((conv.row * 31 + conv.n) | 0) % BEAT_SPAN_MS)
    this.#push(conv, Object.freeze({ id: ++this.#lineId, who: 'you', text, live: false }))
    const intent = intentOf(text)
    if (intent !== 'refused') this.#keep(conv, 'you', text)
    if (intent === 'bye' || intent === 'thanks' || intent === 'refused' || this.#ask) this.#script(conv, intent, id, intent !== 'refused')
    else this.#askModel(conv, intent, id)
  }

  /** Asks the model for turn `id`, with patience: no first words within PATIENCE_MS and the script answers. */
  #askModel(conv: Conv, intent: Intent, id: number): void {
    const ask: Ask = { ctl: new AbortController(), id, intent, phase: null, streaming: false, late: false }
    this.#ask = ask
    conv.turn = 'thinking'
    conv.status = THINKING
    this.#patienceT = this.#clock.after(PATIENCE_MS, () => {
      this.#patienceT = null
      if (this.#ask !== ask || ask.streaming) return
      this.#retire()
      this.#script(conv, intent, id, true)
    })
    let about: string[] = []
    try {
      const ctx = this.#host.context(conv.row)
      if (ctx) about = contextLines(ctx, ABOUT_MAX)
    } catch {
      // nothing known is a prompt still
    }
    let result: Promise<ChatResult>
    try {
      result = this.#o.chat.reply(personPrompt(conv.who, about, conv.turns), conv.who.name, conv.turns.slice(), ask.ctl.signal,
        (soFar) => this.#piece(conv, ask, soFar), (phase) => this.#phase(conv, ask, phase))
    } catch (e) {
      result = Promise.reject(e)
    }
    result.then((r) => this.#answered(conv, ask, r), (e) => this.#answered(conv, ask, { kind: 'failed', why: String(e) }))
    this.#emit()
  }

  /** The request's phase: waiting behind another answer stops it (the script answers); any other is shown. */
  #phase(conv: Conv, ask: Ask, phase: string | null): void {
    ask.phase = phase
    if (phase === WAITING_PHASE) {
      // A late request stops itself once it has to wait (it holds nothing then); a current one hands its turn to the script.
      if (ask.late) ask.ctl.abort()
      if (ask.late || this.#ask !== ask) return
      this.#patienceT = this.#cancel(this.#patienceT)
      ask.ctl.abort()
      this.#ask = null
      this.#script(conv, ask.intent, ask.id, true)
      return
    }
    if (ask.late || this.#ask !== ask || conv !== this.#conv) return
    conv.status = phase ? phaseLine(phase) : THINKING
    this.#emit()
  }

  /** The reply's words so far: shown in whole words; a late request stops here; one reading as a request is replaced. */
  #piece(conv: Conv, ask: Ask, soFar: string): void {
    if (ask.late) {
      ask.ctl.abort()
      return
    }
    if (this.#ask !== ask || conv !== this.#conv) return
    if (!ask.streaming) {
      ask.streaming = true
      this.#patienceT = this.#cancel(this.#patienceT)
    }
    if (parseRequest(soFar) !== null) {
      ask.ctl.abort()
      this.#ask = null
      this.#dropLive(conv)
      this.#script(conv, ask.intent, ask.id, true)
      return
    }
    this.#show(conv, soFar, true)
    this.#emit()
  }

  /** How the request ended: said (unless it reads as a request), refused (a deflection, the turn forgotten), else the script. */
  #answered(conv: Conv, ask: Ask, r: ChatResult): void {
    if (this.#ask === ask) {
      this.#ask = null
      this.#patienceT = this.#cancel(this.#patienceT)
    }
    if (ask.late || ask.ctl.signal.aborted || conv !== this.#conv || ask.id !== this.#turnId) return
    if (r.kind === 'said' && parseRequest(r.text) === null) this.#say(conv, r.text, true, false)
    else if (r.kind === 'refused') {
      if (conv.turns.at(-1)?.who === 'you') conv.turns.pop()
      this.#script(conv, 'refused', ask.id, false)
    } else this.#script(conv, ask.intent, ask.id, true)
  }

  /**
   * Gives up the request in flight: stopped now while it waits behind another answer or streams, else marked late
   * (it is loading or reading the prompt, and stopping the model in this page then would unload it).
   */
  #retire(): void {
    const ask = this.#ask
    if (!ask || ask.late) return
    this.#patienceT = this.#cancel(this.#patienceT)
    if (ask.streaming || ask.phase === WAITING_PHASE) {
      ask.ctl.abort()
      this.#ask = null
    } else ask.late = true
  }

  /** The script's line for `intent` on turn `id`, after what is left of the turn's beat; `keep` adds it to the model's turns. */
  #script(conv: Conv, intent: Intent, id: number, keep: boolean): void {
    conv.turn = 'thinking'
    conv.status = THINKING
    const say = (): void => {
      this.#beatT = null
      if (conv !== this.#conv || id !== this.#turnId) return
      this.#say(conv, lineFor(conv.who, intent, conv.n, conv.used), keep, intent === 'bye')
    }
    const wait = conv.turnAt + conv.beat - this.#clock.now()
    this.#beatT = this.#cancel(this.#beatT)
    if (wait > 0) {
      this.#beatT = this.#clock.after(wait, say)
      this.#emit()
    } else say()
  }

  /** Shows and says the person's line; the turn is theirs until it ends (or for a reading time when no voice says it). */
  #say(conv: Conv, text: string, keep: boolean, closing: boolean, lead = ''): void {
    this.#show(conv, text, false)
    if (keep) this.#keep(conv, 'them', text)
    this.#announce(`${lead}${conv.who.name}: ${text}`)
    conv.turn = 'speaking'
    conv.status = SPEAKING
    conv.closing = closing
    conv.activeAt = this.#clock.now()
    const id = ++this.#voiceId
    const who = conv.who
    let out: ConciergeOut | null = null
    if (conv.real && who.voice.provider !== null) {
      try {
        out = this.#host.out(conv.row, who.label)
      } catch {
        out = null
      }
    }
    const v: PersonVoice = {
      ...who.voice,
      out,
      volume: conv.real ? voiceVolume(this.#curD) : 1,
      caption: conv.real ? (on) => this.#host.caption(conv.row, who.label, on) : undefined,
    }
    this.#voicing = true
    let said: Promise<string>
    try {
      said = this.#o.speaker.person(text, v)
    } catch {
      said = Promise.resolve('silent')
    }
    said.then((tier) => this.#spoken(conv, id, tier, text), () => this.#spoken(conv, id, 'silent', text))
    this.#emit()
  }

  /** The speaker is done with line `id`: a line no voice said is held for its reading time first. */
  #spoken(conv: Conv, id: number, tier: string, text: string): void {
    if (conv !== this.#conv || id !== this.#voiceId) return
    this.#voicing = false
    if (tier !== 'silent') {
      this.#listen(conv)
      return
    }
    const ms = Math.min(READ_MAX_MS, Math.max(READ_MIN_MS, text.length * READ_MS_PER_CHAR))
    this.#readT = this.#clock.after(ms, () => {
      this.#readT = null
      if (conv === this.#conv && id === this.#voiceId) this.#listen(conv)
    })
  }

  /** The person's line is over: back to listening, or, after a farewell, the conversation closes. */
  #listen(conv: Conv): void {
    if (conv.closing) {
      this.end('bye')
      return
    }
    conv.turn = 'listening'
    conv.status = ''
    conv.activeAt = this.#clock.now()
    this.#emit()
  }

  /**
   * Closes the open conversation for `why`, the link going to `next`: the request given up, every timer cleared, a
   * line still being said cut for the endings the player chose (or a card's), the staring setter let go, the page
   * told, and an ending the player did not choose said as a toast.
   */
  #close(why: TalkEnd, next: TalkLink): void {
    const conv = this.#conv
    if (!conv) return
    if (why === 'dispose' && this.#ask) {
      this.#ask.ctl.abort()
      this.#ask = null
    } else this.#retire()
    this.#clearTimers()
    if (this.#voicing && CUTS.has(why)) this.#o.speaker.stop()
    this.#voicing = false
    this.#voiceId++
    this.#conv = null
    this.#state = next
    this.#who = null
    this.#preview = null
    this.#draft = ''
    this.#focused = false
    this.#follow()
    if (conv.real) this.#unlink()
    this.#o.onOpen(false)
    const left = LEFT[why]
    if (left && conv.real) this.#o.toast('Talk', `${conv.who.label} ${left}`)
    this.#emit()
  }

  #clearTimers(): void {
    this.#beatT = this.#cancel(this.#beatT)
    this.#patienceT = this.#cancel(this.#patienceT)
    this.#readT = this.#cancel(this.#readT)
  }

  #cancel(handle: unknown): null {
    if (handle !== null) this.#clock.cancel(handle)
    return null
  }

  #keep(conv: Conv, who: 'you' | 'them', text: string): void {
    conv.turns.push(Object.freeze({ who, text }))
    if (conv.turns.length > PERSON_TURNS) conv.turns.shift()
  }

  #push(conv: Conv, line: TalkLine): void {
    conv.lines.push(line)
    if (conv.lines.length > TRANSCRIPT_LINES) conv.lines.shift()
  }

  /** The person's line: into the line a reply streams into when there is one, else a new one. */
  #show(conv: Conv, text: string, live: boolean): void {
    const i = conv.live < 0 ? -1 : conv.lines.findIndex((l) => l.id === conv.live)
    const line: TalkLine = Object.freeze({ id: i < 0 ? ++this.#lineId : conv.live, who: 'them', text, live })
    if (i < 0) this.#push(conv, line)
    else conv.lines[i] = line
    conv.live = live ? line.id : -1
  }

  /** A reply that stopped streaming unfinished leaves nothing of its words. */
  #dropLive(conv: Conv): void {
    if (conv.live < 0) return
    const i = conv.lines.findIndex((l) => l.id === conv.live)
    if (i >= 0) conv.lines.splice(i, 1)
    conv.live = -1
  }

  #announce(text: string): void {
    this.#said = text
    this.#saidId++
  }

  #snapshot(): TalkUi {
    const conv = this.#conv
    const who = this.#who
    return Object.freeze({
      state: conv ? 'open' : who ? 'near' : 'off',
      turn: conv ? conv.turn : null,
      who,
      serial: this.#serial,
      lines: Object.freeze(conv ? conv.lines.slice() : []),
      status: conv ? conv.status : '',
      focus: this.#focus,
      said: this.#said,
      saidId: this.#saidId,
      preview: this.#preview !== null,
    })
  }

  #emit(): void {
    this.#ui = this.#snapshot()
    for (const fn of this.#subs) {
      try { fn() } catch { /* a listener's fault is not the conversation's */ }
    }
  }

  /** Moves the label to its anchor (inside the layer by EDGE_PX), writing only a move over MOVE_PX or a visibility change. */
  #place(): void {
    const el = this.#el
    if (el === null) return
    const W = this.#W, H = this.#H
    let show = false, px = 0, py = 0
    if (this.#preview === null && this.#who !== null && W > 0 && H > 0) {
      const p = this.#host.place()
      if (Number.isFinite(p.sx) && Number.isFinite(p.sy)) {
        const lo = EDGE_PX + this.#lw / 2, hi = W - lo
        px = lo > hi ? W / 2 : Math.min(hi, Math.max(lo, p.sx * W))
        py = Math.min(H - EDGE_PX, Math.max(EDGE_PX, p.sy * H))
        show = true
      }
    }
    if (show !== this.#shown) {
      this.#shown = show
      el.style.visibility = show ? 'visible' : 'hidden'
    }
    if (show && !(Math.abs(px - this.#px) <= MOVE_PX && Math.abs(py - this.#py) <= MOVE_PX)) {
      this.#px = px
      this.#py = py
      el.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0) translate(-50%, -100%)`
    }
  }
}
