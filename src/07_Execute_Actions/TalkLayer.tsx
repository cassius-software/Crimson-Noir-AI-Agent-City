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
 * - TalkPanel: the conversation itself, where Sloane's card stands (Concierge.tsx's places, so it inherits their care
 *   for the touch buttons, the stick, the minimap and the first walk's card): the person's name, line, bearing and
 *   distance, a Done button, the transcript, the status line, and a plain text field. Enter sends (never while an
 *   input method is still composing), Esc clears the field and, empty, ends the conversation. The field is focused
 *   only when the controller asks and nothing else holds the focus, blurred when the conversation closes, and the
 *   conversation closes as 'away' when the page is hidden. Each opening and each finished reply is told once to a
 *   screen reader through a polite status line.
 * There is no key grid here: any keyboard (a system's, a phone's, a virtual one) types into the plain field.
 * What breaks if it is removed? Nobody near shows a label, an open conversation has no panel, and there is nowhere
 * to type to the person or read what they said.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { isOpen } from '../04_Connect_Hardware/microphone.ts'
import type { SipocSnapshot } from '../05_Observe_Environment/telemetry.ts'
import { besideRoom, CARD_AT, SHORT, SMALL, WIDE_BESIDE, WIDE_COLUMN, WIDE_SPACER } from './Concierge.tsx'
import { glyph, glyphKind, type GlyphFamily } from './glyphs.ts'
import { GlyphKey } from './Hud.tsx'
import { HEARD_MAX } from './onboarding/heard.ts'
import type { TalkController, TalkTurn, TalkUi } from './talk.ts'

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
  const key = ui.state === 'near' && family ? glyph('talk', family) : ''
  const kind = key && family ? glyphKind('talk', family) : 'key'
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
 * The conversation panel where Sloane's card stands (her card cannot be open meanwhile, and her chip stays, under it
 * where the two meet). Its root is always there, so the polite status line exists before the first thing it tells.
 */
export function TalkPanel({ talk, family, overlay = family === 'touch', dark = false, beside = false, zoom = 1, voice = null }: TalkPanelProps) {
  const ui = useTalk(talk)
  const small = useSyncExternalStore(SMALL.subscribe, SMALL.matches, SMALL.server)
  const room = besideRoom(zoom)
  const roomy = useSyncExternalStore(room.subscribe, room.matches, room.server)
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
  const at = wide ? 'relative shrink-0' : `absolute ${layout === 'tall' ? (overlay ? CARD_AT.tallTouch : CARD_AT.tall) : !overlay ? CARD_AT.shortRaised : CARD_AT.short}`
  const card = open && <Conversation talk={talk} ui={ui} family={family} dark={dark} at={at} tight={layout === 'short'} compact={compact} voice={voice} />
  return (
    <div className="ui-zoom pointer-events-none absolute inset-0 z-[31] font-sans text-[13px] antialiased">
      <p className="sr-only" role="status" aria-live="polite" data-talk="said">{open && <span key={ui.saidId}>{ui.said}</span>}</p>
      {card && (wide ? <div className={beside && roomy ? WIDE_BESIDE : WIDE_COLUMN}>{card}<div aria-hidden className={WIDE_SPACER} /></div> : card)}
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
  const panel = useRef<HTMLElement | null>(null)
  const field = useRef<HTMLInputElement | null>(null)
  const list = useRef<HTMLOListElement | null>(null)
  // A focus request is honoured only while nothing else holds the focus (the page, the canvas, or this panel).
  useLayoutEffect(() => {
    if (ui.focus === (HANDLED.get(talk) ?? 0)) return
    HANDLED.set(talk, ui.focus)
    const a = document.activeElement
    if (a === null || a === document.body || a instanceof HTMLCanvasElement || panel.current?.contains(a)) field.current?.focus({ preventScroll: true })
  }, [talk, ui.focus])
  // As the conversation closes, before the panel goes, a focus inside it is let go (the city's keys work again).
  useEffect(() => talk.subscribe(() => {
    if (talk.ui().state === 'open') return
    const a = document.activeElement
    if (a instanceof HTMLElement && panel.current?.contains(a)) a.blur()
  }), [talk])
  // The newest line in view.
  useLayoutEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [ui.lines])
  const who = ui.who
  if (!who) return null
  const type = (text: string) => {
    setDraft(text)
    talk.setDraft(text, true)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (talk.send(draft) === 'empty') return
    setDraft('')
    talk.setDraft('', document.activeElement === field.current)
    // On a keyboard the field lets go after a line, so W A S D walk again.
    if (family === 'keyboard') field.current?.blur()
  }
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      if (e.key === 'Enter') e.preventDefault()
      return
    }
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    if (draft) type('')
    else talk.end('done')
  }
  const where = talk.hud()
  const far = where && Number.isFinite(where.metres) ? where : null
  const done = family === 'touch' ? '' : family === 'keyboard' ? 'Esc' : glyph('talk', family)
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
      className={`pointer-events-auto ${at} rounded-3xl border backdrop-blur-2xl backdrop-saturate-150 ${glass} ${tight ? 'px-4 py-3' : 'px-5 py-4'} ${enter}`}
    >
      <div className="flex items-start gap-2 leading-tight">
        <div className="min-w-0 flex-1">
          <bdi className="block truncate text-[14px] font-semibold tracking-tight">{who.label}</bdi>
          <span className={`block truncate text-[11px] ${muted}`}>
            {who.line}
            {far && <> · <span aria-hidden>{far.arrow} </span>{far.metres} m<span className="sr-only"> {far.word}</span></>}
          </span>
        </div>
        <button type="button" onClick={() => talk.end('done')} className={`flex shrink-0 items-center gap-1.5 rounded-full border py-1 text-[12px] font-medium ${done ? 'pr-1 pl-3' : 'px-3'} ${chip}`} data-talk="done">
          Done{done && <GlyphKey glyph={done} kind={family === 'keyboard' ? 'key' : glyphKind('talk', family)} />}
        </button>
      </div>
      <ol ref={list} aria-live="off" className={`${tight ? 'mt-2' : 'mt-3'} flex max-h-[8.5rem] flex-col gap-1 overflow-y-auto overscroll-contain text-[13px] leading-snug`} data-talk="transcript">
        {ui.lines.map((l) => (
          <li key={l.id} data-who={l.who} className={l.live ? 'opacity-80' : undefined}>
            <span className={`font-semibold ${muted}`}>{l.who === 'you' ? 'You' : <bdi>{who.name}</bdi>}: </span>
            <bdi>{l.text}</bdi>
          </li>
        ))}
      </ol>
      {ui.status && <p className={`mt-1 text-[11px] leading-snug ${muted}`} data-talk="status">{ui.status}</p>}
      <form onSubmit={submit} className="mt-2 flex items-center gap-2">
        <input type="text"
          ref={field}
          value={draft}
          onChange={(e) => type(e.currentTarget.value)}
          onKeyDown={onKey}
          onFocus={() => talk.setDraft(draft, true)}
          onBlur={() => talk.setDraft(draft, false)}
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
      {hint && <p className={`mt-1.5 text-[11px] leading-snug ${muted}`} data-talk="mic">{hint}</p>}
    </section>
  )
}
