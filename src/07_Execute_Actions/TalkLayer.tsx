// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is what the player sees of a conversation with the person near them (talk.ts). Two parts.
 * - TalkLabel: the small label over the head of the person offered or talked with, their name and line, the key that
 *   opens the conversation while they are only offered, and a mark for their turn once it is open (a ring while they
 *   listen, three dots while they think, three bars while they speak). React draws its words only when the
 *   conversation's snapshot changes; where it stands is written by the controller straight to its transform every
 *   frame, from the layer's size (a ResizeObserver) and the label's width (measured once per change of its words).
 *   The layer takes no pointer and clips at its edges. It carries the text size's zoom like every other overlay, so
 *   its size, the label's width and the transform are all in the zoom's own lengths and the label lands on the head.
 * - TalkPanel: the conversation itself, in places of its own beside Sloane's chip (PANEL_AT: her card's care for the
 *   touch buttons, the stick, the minimap and the first walk's card, and never over her chip or the HUD's captions):
 *   the person's name, line, bearing and distance, a Done button, the transcript, the status line, and a plain text
 *   field. Enter sends (never while an input method is still composing); Esc clears the field and, empty, ends the
 *   conversation, from the field or from anywhere but another text field (talkField.ts). The field is focused when
 *   the controller asks and no other text field holds the keyboard, types nothing for the repeats of a key held as it
 *   took it, is blurred when the conversation closes, and the conversation closes as 'away' when the page is hidden.
 *   Each opening and each finished reply is told once to a screen reader through a polite status line. On a wide
 *   screen the open panel publishes its head (--talk-top) so the HUD's captions stand above it.
 * There is no key grid here: any keyboard (a system's, a phone's, a virtual one) types into the plain field.
 * What breaks if it is removed? Nobody near shows a label, an open conversation has no panel, and there is nowhere
 * to type to the person or read what they said.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { isOpen } from '../04_Connect_Hardware/microphone.ts'
import type { SipocSnapshot } from '../05_Observe_Environment/telemetry.ts'
import { besideRoom, roomAcross, SHORT, SMALL, WIDE_COLUMN, WIDE_SPACER } from './Concierge.tsx'
import { glyph, glyphKind, type GlyphFamily } from './glyphs.ts'
import { GlyphKey } from './Hud.tsx'
import { HEARD_MAX } from './onboarding/heard.ts'
import { pageHand } from './padNav.ts'
import type { TalkController, TalkTurn, TalkUi } from './talk.ts'
import { escapeAction, FieldDraft, mayFocus, RepeatGate } from './talkField.ts'

/** The microphone as the HUD has it (snapshot.supplier.voice): open or not, and whether its words are read. */
export type TalkMic = Pick<NonNullable<SipocSnapshot['supplier']['voice']>, 'phase' | 'words'>

/** The conversation's snapshot, new only on its edges (talk.ts ui()). The controller's methods need their object. */
function useTalk(talk: TalkController): TalkUi {
  const subscribe = useCallback((fn: () => void) => talk.subscribe(fn), [talk])
  const snapshot = useCallback(() => talk.ui(), [talk])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** The mark for the person's turn in the label (index.css draws it, still under reduced motion). */
function Mark({ turn }: { turn: TalkTurn }) {
  return <span data-talk-mark={turn} className="shrink-0">{turn === 'listening' ? <i /> : <><i /><i /><i /></>}</span>
}

/** The label over the head of the person offered or talked with. `family` names the key that opens it (none on touch or when left out). */
export function TalkLabel({ talk, family }: { talk: TalkController; family?: GlyphFamily }) {
  const ui = useTalk(talk)
  const label = useRef<HTMLDivElement | null>(null)
  const who = ui.state === 'off' ? null : ui.who
  // The pad hand the accessibility settings chose (padNav.ts): a left hand talks with the d-pad's up.
  const hand = pageHand()
  const key = ui.state === 'near' && family ? glyph('talk', family, hand) : ''
  const kind = key && family ? glyphKind('talk', family, hand) : 'key'
  // The layer's size in its own (zoomed) lengths: on a resize, on a change of the text size (written onto <html>'s
  // style by access.ts, which a full-screen layer's own box may not report), and only when it changed.
  const layer = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    let w = -1, h = -1
    const size = () => {
      if (el.offsetWidth === w && el.offsetHeight === h) return
      w = el.offsetWidth
      h = el.offsetHeight
      talk.setLayerSize(w, h)
    }
    size()
    const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(size) : null
    sized?.observe(el)
    const zoomed = typeof MutationObserver === 'function' ? new MutationObserver(size) : null
    zoomed?.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    window.addEventListener('resize', size)
    return () => { sized?.disconnect(); zoomed?.disconnect(); window.removeEventListener('resize', size) }
  }, [talk])
  const attach = useCallback((el: HTMLDivElement | null) => {
    label.current = el
    talk.attachLabel(el)
    return () => {
      label.current = null
      talk.attachLabel(null)
    }
  }, [talk])
  // Measured once per change of what it says, never per frame.
  useLayoutEffect(() => {
    talk.setLabelWidth(label.current?.offsetWidth ?? 0)
  }, [talk, who, ui.turn, key])
  return (
    <div ref={layer} className="ui-zoom pointer-events-none absolute inset-0 overflow-hidden" data-talk="layer">
      <div ref={attach} aria-hidden="true" data-talk="label" className="max-w-[16rem] rounded-xl border border-white/10 bg-slate-950/85 px-2.5 py-1 font-sans text-[13px] leading-tight whitespace-nowrap text-slate-50 shadow-[0_6px_20px_rgba(0,0,0,0.35)] antialiased select-none">
        {who && (
          <div key={`${who.row}:${ui.serial}`} className="flex items-center gap-2 transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none">
            <div className="min-w-0">
              <bdi className="block truncate font-semibold">{who.label}</bdi>
              <span className="block truncate text-[11px] text-slate-300">{who.line}</span>
            </div>
            {key && <GlyphKey glyph={key} kind={kind} />}
            {ui.turn && <Mark turn={ui.turn} />}
          </div>
        )}
      </div>
    </div>
  )
}

export interface TalkPanelProps {
  talk: TalkController
  /** Control glyphs matching the input in use (snapshot.supplier.glyphs). */
  family: GlyphFamily
  /** The touch overlay is on screen (snapshot.supplier.touch); defaults to touch glyphs, as Sloane's card does. */
  overlay?: boolean
  /** The HUD's night glass. */
  dark?: boolean
  /** The first walk's card is on screen: the wide column keeps left of it, as Sloane's does. */
  beside?: boolean
  /** The text size's zoom (access.ts scale / 100). */
  zoom?: number
  /** The microphone (snapshot.supplier.voice), for the line under the field. */
  voice?: TalkMic | null
}

/**
 * Where the panel stands (full class strings, so Tailwind sees them). Sloane's card replaces her chip, but this panel
 * stands beside it, and nothing may lie over her chip (its buttons are what the first walk asks the visitor to tap), so
 * the panel has places of its own, in the lengths of the text size's zoom like hers (every window pixel divided by
 * --ui-zoom first).
 * - Wide: a column like hers (Concierge.tsx WIDE_COLUMN) whose left edge clears her chip, which stands above the
 *   minimap up to 18 rem wide; it keeps 22 rem across where it can, centred in what is left up to 38 rem. A window
 *   under WIDE_CLEAR_REM across (at the zoom) has no such room: there the panel takes her column and her chip is
 *   tucked away. On a wide screen the card never runs past the screen's top: past that its transcript gives way.
 * - Upright (tall, and tallTouch over the touch buttons): under her chip (--chip-bottom, published while it stands
 *   under the minimap, as the first walk's compact card stands), down to the HUD's chips at the foot (--hud-foot, so
 *   the captions are never under it) and the touch buttons.
 * - Sideways with the touch buttons (short): between the thumbs (clear of the stick's zone, which is not zoomed, unless
 *   that would leave under 16 rem, as her card gives up the stick's inner edge), above the HUD's chips at the foot. No
 *   band there is clear of her chip and still tall enough to read a reply in, so her chip is tucked away while the
 *   conversation is open (TalkPanel's data-chip-tucked; it stays mounted, so a line said to her still reaches her) and
 *   comes back as it closes.
 * - A short window without them (shortRaised): centred and raised over the bottom-centre prompts, under her chip.
 * - Where the band under her chip is short of 11 rem (a large text size on a small phone, measured by PROBE_AT),
 *   her chip is tucked too and the panel takes the whole height (the *Tucked places), over the HUD's header and
 *   minimap, which take no taps. The probe reads the screen alone (never the HUD's chips at the foot, which come and
 *   go with the captions), so her chip never blinks during a conversation.
 * The panel is a column whose head (name and Done) and field (and Send) never give way: the transcript, the status and
 * microphone lines do, and only where even the head and field outrun the band does the panel scroll.
 */
const PANEL_AT = {
  wide: 'absolute top-[calc(50%+1rem)] bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-[calc(max(1.25rem,env(safe-area-inset-left))_+_18.5rem)] right-[max(max(1.25rem,env(safe-area-inset-right)),min(calc(max(1.25rem,env(safe-area-inset-right))_+_15.25rem),calc(100%_-_max(1.25rem,env(safe-area-inset-left))_-_40.5rem)))] mx-auto flex w-auto max-w-[38rem] flex-col justify-end',
  wideBeside: 'absolute top-[calc(50%+1rem)] bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-[calc(max(1.25rem,env(safe-area-inset-left))_+_18.5rem)] right-[calc(max(1.25rem,env(safe-area-inset-right))_+_20.75rem)] mx-auto flex w-auto max-w-[38rem] flex-col justify-end',
  tall: 'top-[max(calc(max(0.75rem,env(safe-area-inset-top))_+_7.5rem),calc(var(--chip-bottom,0px)_+_0.5rem))] right-[max(0.75rem,env(safe-area-inset-right))] left-[max(0.75rem,env(safe-area-inset-left))] mx-auto max-h-[calc(calc(calc(100dvh_-_var(--keys-height,0px))_/_var(--ui-zoom,1))_-_max(calc(max(0.75rem,env(safe-area-inset-top))_+_7.5rem),calc(var(--chip-bottom,0px)_+_0.5rem))_-_max(max(0.75rem,env(safe-area-inset-bottom)),calc(calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))_+_0.5rem)))] max-w-[28rem] overflow-y-auto overscroll-contain',
  tallTouch: 'top-[max(calc(max(0.75rem,env(safe-area-inset-top))_+_7.5rem),calc(var(--chip-bottom,0px)_+_0.5rem))] right-[max(0.75rem,env(safe-area-inset-right))] left-[max(0.75rem,env(safe-area-inset-left))] mx-auto max-h-[calc(calc(calc(100dvh_-_var(--keys-height,0px))_/_var(--ui-zoom,1))_-_max(calc(max(0.75rem,env(safe-area-inset-top))_+_7.5rem),calc(var(--chip-bottom,0px)_+_0.5rem))_-_max(calc(var(--touch-top,0.75rem)_/_var(--ui-zoom,1)),calc(var(--hud-foot,0px)_/_var(--ui-zoom,1)))_-_0.5rem)] max-w-[28rem] overflow-y-auto overscroll-contain',
  tallTucked: 'top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] left-[max(0.75rem,env(safe-area-inset-left))] mx-auto max-h-[calc(calc(calc(100dvh_-_var(--keys-height,0px))_/_var(--ui-zoom,1))_-_max(0.75rem,env(safe-area-inset-top))_-_max(max(0.75rem,env(safe-area-inset-bottom)),calc(calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))_+_0.5rem)))] max-w-[28rem] overflow-y-auto overscroll-contain',
  tallTouchTucked: 'top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] left-[max(0.75rem,env(safe-area-inset-left))] mx-auto max-h-[calc(calc(calc(100dvh_-_var(--keys-height,0px))_/_var(--ui-zoom,1))_-_max(0.75rem,env(safe-area-inset-top))_-_max(calc(var(--touch-top,0.75rem)_/_var(--ui-zoom,1)),calc(var(--hud-foot,0px)_/_var(--ui-zoom,1)))_-_0.5rem)] max-w-[28rem] overflow-y-auto overscroll-contain',
  short: 'bottom-[max(max(0.75rem,env(safe-area-inset-bottom)),calc(calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))_+_0.5rem))] left-[max(calc(env(safe-area-inset-left,0px)_+_0.75rem),min(calc(env(safe-area-inset-left,0px)_+_calc(12.5rem_/_var(--ui-zoom,1))),calc(100%_-_calc(var(--touch-left,12rem)_/_var(--ui-zoom,1))_-_16rem)))] right-[calc(calc(var(--touch-left,12rem)_/_var(--ui-zoom,1))_+_0.5rem)] mx-auto max-h-[calc(calc(calc(100dvh_-_var(--keys-height,0px))_/_var(--ui-zoom,1))_-_max(max(0.75rem,env(safe-area-inset-bottom)),calc(calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))_+_0.5rem))_-_max(0.75rem,env(safe-area-inset-top)))] max-w-[28rem] overflow-y-auto overscroll-contain',
  shortRaised: 'bottom-[max(calc(max(0.75rem,env(safe-area-inset-bottom))_+_4.5rem),calc(calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))_+_0.5rem))] left-1/2 max-h-[calc(calc(calc(100dvh_-_var(--keys-height,0px))_/_var(--ui-zoom,1))_-_max(calc(max(0.75rem,env(safe-area-inset-bottom))_+_4.5rem),calc(calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))_+_0.5rem))_-_max(max(0.75rem,env(safe-area-inset-top)),calc(var(--chip-bottom,0px)_+_0.5rem)))] w-[min(28rem,calc(100%_-_26rem_-_env(safe-area-inset-left,0px)_-_env(safe-area-inset-right,0px)))] min-w-[18rem] -translate-x-1/2 overflow-y-auto overscroll-contain',
  shortRaisedTucked: 'bottom-[max(calc(max(0.75rem,env(safe-area-inset-bottom))_+_4.5rem),calc(calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))_+_0.5rem))] left-1/2 max-h-[calc(calc(calc(100dvh_-_var(--keys-height,0px))_/_var(--ui-zoom,1))_-_max(calc(max(0.75rem,env(safe-area-inset-bottom))_+_4.5rem),calc(calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))_+_0.5rem))_-_max(0.75rem,env(safe-area-inset-top)))] w-[min(28rem,calc(100%_-_26rem_-_env(safe-area-inset-left,0px)_-_env(safe-area-inset-right,0px)))] min-w-[18rem] -translate-x-1/2 overflow-y-auto overscroll-contain',
} as const
/** The least window across, in rem of the zoom, for the wide column right of her chip: her chip's 19.75 rem, the
 *  column's 22 rem and the frame's 1.25 rem. */
const WIDE_CLEAR_REM = 43
/** The card in a wide column: its own height, but never past the screen's top (the frame's insets and the column's
 *  least spacer off the viewport less the on-screen keys). */
const WIDE_CARD = 'shrink-0 max-h-[calc(calc(calc(100dvh_-_var(--keys-height,0px))_/_var(--ui-zoom,1))_-_max(1.25rem,env(safe-area-inset-top))_-_max(1.25rem,env(safe-area-inset-bottom))_-_3.25rem)] overflow-y-auto overscroll-contain'
/**
 * The band under her chip (the same top as the place, the touch buttons or the screen's foot as its foot) less 11 rem,
 * the least that holds the panel's head, a few lines and its field, never below nothing: an element whose height is
 * 0 says the band is too short, at any zoom.
 */
const PROBE_AT = {
  tall: 'h-[max(0px,calc(calc(calc(100dvh_-_var(--keys-height,0px))_/_var(--ui-zoom,1))_-_max(calc(max(0.75rem,env(safe-area-inset-top))_+_7.5rem),calc(var(--chip-bottom,0px)_+_0.5rem))_-_max(0.75rem,env(safe-area-inset-bottom))_-_11rem))]',
  tallTouch: 'h-[max(0px,calc(calc(calc(100dvh_-_var(--keys-height,0px))_/_var(--ui-zoom,1))_-_max(calc(max(0.75rem,env(safe-area-inset-top))_+_7.5rem),calc(var(--chip-bottom,0px)_+_0.5rem))_-_calc(var(--touch-top,0.75rem)_/_var(--ui-zoom,1))_-_0.5rem_-_11rem))]',
  shortRaised: 'h-[max(0px,calc(calc(calc(100dvh_-_var(--keys-height,0px))_/_var(--ui-zoom,1))_-_calc(max(0.75rem,env(safe-area-inset-bottom))_+_4.5rem)_-_max(max(0.75rem,env(safe-area-inset-top)),calc(var(--chip-bottom,0px)_+_0.5rem))_-_11rem))]',
} as const

/**
 * The conversation panel, in a place of its own beside Sloane's chip (her card cannot be open meanwhile). Its root is
 * always there, so the polite status line exists before the first thing it tells.
 */
export function TalkPanel({ talk, family, overlay = family === 'touch', dark = false, beside = false, zoom = 1, voice = null }: TalkPanelProps) {
  const ui = useTalk(talk)
  const small = useSyncExternalStore(SMALL.subscribe, SMALL.matches, SMALL.server)
  const room = besideRoom(zoom)
  const roomy = useSyncExternalStore(room.subscribe, room.matches, room.server)
  const across = roomAcross(WIDE_CLEAR_REM, zoom)
  const clear = useSyncExternalStore(across.subscribe, across.matches, across.server)
  const short = useSyncExternalStore(SHORT.subscribe, SHORT.matches, SHORT.server)
  const open = ui.state === 'open' && ui.who !== null
  // A hidden page closes the conversation: nobody stands talking to a tab in the background.
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden' && talk.ui().state === 'open') talk.end('away') }
    document.addEventListener('visibilitychange', hidden)
    return () => document.removeEventListener('visibilitychange', hidden)
  }, [talk])
  // Concierge.tsx's rule for her card (no driving place: a conversation never stays open at the wheel).
  const compact = small || overlay
  const layout = !compact ? 'wide' : short ? 'short' : 'tall'
  const wide = layout === 'wide'
  // Whether the band under her chip is too short (PROBE_AT): measured while open, from a probe whose height is 0 then.
  const [cramped, setCramped] = useState(false)
  const probeAt = layout === 'tall' ? (overlay ? PROBE_AT.tallTouch : PROBE_AT.tall) : layout === 'short' && !overlay ? PROBE_AT.shortRaised : null
  const probe = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const read = () => setCramped(el.offsetHeight < 1)
    read()
    const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(read) : null
    sized?.observe(el)
    return () => sized?.disconnect()
  }, [])
  // Her chip is tucked away while the conversation stands where it would lie over it (index.css data-chip-tucked),
  // before the panel is painted, and comes back as it closes or the panel goes.
  const tucked = open && (wide ? !clear : (layout === 'short' && overlay) || cramped)
  useLayoutEffect(() => {
    if (!tucked) return
    const root = document.documentElement
    root.setAttribute('data-chip-tucked', '')
    return () => root.removeAttribute('data-chip-tucked')
  }, [tucked])
  const place = layout === 'tall'
    ? (overlay ? (tucked ? PANEL_AT.tallTouchTucked : PANEL_AT.tallTouch) : tucked ? PANEL_AT.tallTucked : PANEL_AT.tall)
    : overlay ? PANEL_AT.short : tucked ? PANEL_AT.shortRaisedTucked : PANEL_AT.shortRaised
  const at = wide ? `relative ${WIDE_CARD}` : `absolute ${place}`
  const card = open && <Conversation talk={talk} ui={ui} family={family} dark={dark} at={at} tight={!wide} compact={compact} voice={voice} />
  return (
    <div className="ui-zoom pointer-events-none absolute inset-0 z-[31] font-sans text-[13px] antialiased">
      <p className="sr-only" role="status" aria-live="polite" data-talk="said">{open && <span key={ui.saidId}>{ui.said}</span>}</p>
      {open && probeAt && <div ref={probe} aria-hidden className={`invisible absolute top-0 left-0 w-px ${probeAt}`} data-talk="probe" />}
      {card && (wide ? <div className={!clear ? WIDE_COLUMN : beside && roomy ? PANEL_AT.wideBeside : PANEL_AT.wide}>{card}<div aria-hidden className={WIDE_SPACER} /></div> : card)}
    </div>
  )
}

/** The focus requests (TalkUi.focus) already handled, per controller, so a panel mounted on an opening sees its own. */
const HANDLED = new WeakMap<TalkController, number>()

/** The line under the field: speak, turn the microphone on, or type. */
function micLine(voice: TalkMic | null, family: GlyphFamily): string {
  if (!voice) return ''
  if (isOpen(voice.phase)) return voice.words ? 'Or just say it.' : 'No words are heard here yet: type.'
  if (voice.phase === 'opening') return 'The microphone is opening. Or type.'
  if (voice.phase === 'blocked') return 'Microphone blocked: type here.'
  if (voice.phase === 'error' || voice.phase === 'unavailable') return 'No microphone here: type.'
  return family === 'touch' ? 'Microphone off: the Menu turns it on, or type.' : `Microphone off: ${glyph('mic', family)} turns it on, or type.`
}

/** The open panel. Mounted for each conversation, so its field starts empty every time. */
function Conversation({ talk, ui, family, dark, at, tight, compact, voice }: {
  talk: TalkController; ui: TalkUi; family: GlyphFamily; dark: boolean; at: string; tight: boolean; compact: boolean; voice: TalkMic | null
}) {
  const [draft, setDraft] = useState('')
  // The field's text as the controller hears it, kept at once (talkField.ts): a blur inside the send handler reads it.
  const [keep] = useState(() => new FieldDraft(talk))
  // The repeats of a key held as the field took the keyboard type nothing (talkField.ts).
  const [gate] = useState(() => new RepeatGate())
  const panel = useRef<HTMLElement | null>(null)
  const field = useRef<HTMLInputElement | null>(null)
  const list = useRef<HTMLOListElement | null>(null)
  // A focus request is honoured unless another text field holds the keyboard (talkField.ts mayFocus): the page, the
  // canvas, a focused button and this panel all give it up.
  useLayoutEffect(() => {
    if (ui.focus === (HANDLED.get(talk) ?? 0)) return
    HANDLED.set(talk, ui.focus)
    if (!mayFocus(document.activeElement, (el) => panel.current?.contains(el) === true)) return
    gate.focused()
    field.current?.focus({ preventScroll: true })
  }, [talk, ui.focus, gate])
  // Esc that reaches the page from anywhere but a text field finishes, a draft cleared first (talkField.ts
  // escapeAction): after a sent line the field has let go, and the Done button's Esc still holds. The field's own Esc
  // is handled and stopped there, so it is never seen twice.
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      const act = escapeAction(e, keep.text)
      if (act === null) return
      e.preventDefault()
      if (act === 'end') talk.end('done')
      else {
        setDraft('')
        keep.type('')
      }
    }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [talk, keep])
  // As the conversation closes, before the panel goes, a focus inside it is let go (the city's keys work again).
  useEffect(() => talk.subscribe(() => {
    if (talk.ui().state === 'open') return
    const a = document.activeElement
    if (a instanceof HTMLElement && panel.current?.contains(a)) a.blur()
  }), [talk])
  // On a wide screen its head, in window pixels, as --talk-top: the HUD's captions stand above it (Hud.tsx), not under it.
  useLayoutEffect(() => {
    const el = panel.current
    if (compact || !el) return
    const root = document.documentElement.style
    const publish = () => root.setProperty('--talk-top', `${Math.round(el.getBoundingClientRect().top)}px`)
    publish()
    const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null
    sized?.observe(el)
    // Again where its entrance (a short slide up) comes to rest.
    el.addEventListener('transitionend', publish)
    window.addEventListener('resize', publish)
    return () => {
      sized?.disconnect()
      el.removeEventListener('transitionend', publish)
      window.removeEventListener('resize', publish)
      root.removeProperty('--talk-top')
    }
  }, [compact])
  // The newest line in view.
  useLayoutEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [ui.lines])
  const who = ui.who
  if (!who) return null
  const type = (text: string) => {
    setDraft(text)
    keep.type(text)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (talk.send(keep.text) === 'empty') return
    setDraft('')
    // On a keyboard the field lets go after a line, so W A S D walk again. The field is empty before it lets go, and
    // the controller hears it empty after (FieldDraft.sent), so the line just sent never stands as a draft.
    keep.sent(() => { if (family === 'keyboard') field.current?.blur() }, () => document.activeElement === field.current)
  }
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!gate.pass(e.repeat)) {
      e.preventDefault()
      return
    }
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      if (e.key === 'Enter') e.preventDefault()
      return
    }
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    if (keep.text) type('')
    else talk.end('done')
  }
  const where = talk.hud()
  const far = where && Number.isFinite(where.metres) ? where : null
  // The pad's talk button ends it too: the d-pad's up for a left hand (padNav.ts pageHand).
  const hand = pageHand()
  const done = family === 'touch' ? '' : family === 'keyboard' ? 'Esc' : glyph('talk', family, hand)
  const glass = dark
    ? 'border-white/10 bg-slate-900/60 text-slate-50 shadow-[0_20px_60px_rgba(0,0,0,0.45)]'
    : 'border-white/70 bg-white/70 text-slate-900 shadow-[0_20px_60px_rgba(15,23,42,0.28)]'
  const muted = dark ? 'text-slate-300/80' : 'text-slate-500'
  const input = dark
    ? 'border-white/15 bg-slate-950/40 text-slate-50 placeholder:text-slate-400 focus:border-white/40'
    : 'border-slate-900/15 bg-white/85 text-slate-900 placeholder:text-slate-400 focus:border-slate-900/40'
  const primary = dark ? 'bg-white text-slate-900' : 'bg-slate-900 text-white'
  const chip = dark ? 'border-white/15 bg-white/10 hover:bg-white/20' : 'border-slate-900/15 bg-white/60 hover:bg-white'
  const enter = 'transition-[opacity,translate] duration-300 ease-out starting:translate-y-2 starting:opacity-0 motion-reduce:transition-none'
  const hint = micLine(voice, family)
  return (
    <section
      ref={panel}
      data-talk="panel"
      data-turn={ui.turn ?? undefined}
      aria-label={`Conversation with ${who.label}`}
      className={`pointer-events-auto ${at} flex flex-col rounded-3xl border backdrop-blur-2xl backdrop-saturate-150 ${glass} ${tight ? 'px-4 py-3' : 'px-5 py-4'} ${enter}`}
    >
      <div className="flex shrink-0 items-start gap-2 leading-tight">
        <div className="min-w-0 flex-1">
          <bdi className="block truncate text-[14px] font-semibold tracking-tight">{who.label}</bdi>
          <span className={`block truncate text-[11px] ${muted}`}>
            {who.line}
            {far && <> · <span aria-hidden>{far.arrow} </span>{far.metres} m<span className="sr-only"> {far.word}</span></>}
          </span>
        </div>
        <button type="button" onClick={() => talk.end('done')} className={`flex shrink-0 items-center gap-1.5 rounded-full border py-1 text-[12px] font-medium ${done ? 'pr-1 pl-3' : 'px-3'} ${chip}`} data-talk="done">
          Done{done && <GlyphKey glyph={done} kind={family === 'keyboard' ? 'key' : glyphKind('talk', family, hand)} />}
        </button>
      </div>
      <ol ref={list} aria-live="off" className={`${tight ? 'mt-2' : 'mt-3'} flex max-h-[8.5rem] min-h-0 shrink flex-col gap-1 overflow-y-auto overscroll-contain text-[13px] leading-snug`} data-talk="transcript">
        {ui.lines.map((l) => (
          <li key={l.id} data-who={l.who} className={l.live ? 'opacity-80' : undefined}>
            <span className={`font-semibold ${muted}`}>{l.who === 'you' ? 'You' : <bdi>{who.name}</bdi>}: </span>
            <bdi>{l.text}</bdi>
          </li>
        ))}
      </ol>
      {ui.status && <p className={`mt-1 min-h-0 shrink-[4] overflow-hidden text-[11px] leading-snug ${muted}`} data-talk="status">{ui.status}</p>}
      <form onSubmit={submit} className="mt-2 flex shrink-0 items-center gap-2">
        <input type="text"
          ref={field}
          value={draft}
          onChange={(e) => type(e.currentTarget.value)}
          onKeyDown={onKey}
          onFocus={() => keep.focus()}
          onBlur={() => keep.blur()}
          enterKeyHint="send"
          autoComplete="off"
          autoCapitalize="sentences"
          spellCheck
          maxLength={HEARD_MAX}
          dir="auto"
          aria-label={`Say to ${who.name}`}
          placeholder={family === 'keyboard' ? 'Say something · Enter to send' : 'Say something'}
          className={`min-w-0 flex-1 rounded-xl border px-3 py-2 outline-none ${compact ? 'text-[16px]' : 'text-[14px]'} ${input}`}
        />
        <button type="submit" disabled={!draft.trim()} className={`shrink-0 rounded-xl px-3.5 py-2 text-[13px] font-semibold disabled:opacity-40 ${primary}`}>Send</button>
      </form>
      {hint && <p className={`mt-1.5 min-h-0 shrink-[8] overflow-hidden text-[11px] leading-snug ${muted}`} data-talk="mic">{hint}</p>}
    </section>
  )
}
