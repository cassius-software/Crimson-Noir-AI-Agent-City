// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the spatial HUD's Concierge: Sloane (they/them), an original character
 * who meets the player as the boot veil lifts. On a first visit Sloane asks what to call them — with a
 * keyboard the name field is already focused, so they just type and press Enter (zero clicks) — saves
 * the profile that seeds their avatar, and answers by name with three glyph-aware tips. A returning
 * player is welcomed back by name. Either way Sloane then offers to take a goal: a plain-language wish
 * ("make it night", "it feels laggy") that the deterministic 5-Whys engine in intent.ts refines through a
 * few questions with quick-reply chips and a text field, then shows as a brief — the steps the host
 * applied ticked, the rest as a plan — with a copyable architecture brief for an engineer. A goal about
 * work is dispatched: the host opens the brief's team (08_Swarm/team.ts) and its lanes show under the
 * brief as they read the city. Sloane may say the brief's sentence in their own words (the host's `reword`,
 * the page's mind): the words change, never the plan, and the planner's sentence stands until they arrive.
 * A goal that is talk ("how's it going", "who are you", intent.ts Brief.chat) is a conversation instead: the host's
 * `chat` (onboarding/voice.ts sloaneChat) streams the model's reply onto the card and the field stays open for the next
 * turn, where anything that maps to the city is a goal again. Where no model answers, Sloane says so plainly and offers
 * the ways to get one (a model file kept in this page, a server on this computer); nothing is sent and nothing applied.
 * The card then settles into a small chip that offers the goal dialogue and reopens the full control list.
 * The ORC Notice is the card's fine print (on a phone held in landscape, only in the full list).
 * What breaks if it is removed? Nobody is greeted, the avatar never gets a name or seed, first-time
 * players get no controls help, a goal has nowhere to go, and the ORC Notice is no longer shown in the
 * running product.
 *
 * Only the card and the chip take pointer events. Placement never covers the centre of view: desktop,
 * below the centre and above the HUD's bottom-centre prompts; phone upright, the band under the header and
 * minimap (clear of the on-screen keyboard); phone in landscape, bottom-centre between the thumbs.
 */
import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { ORC_NOTICE } from '../02_Define_The_Rules/degrees.ts'
import { NAME_MAX, saveProfile, sanitizeName, seedFromName, type Profile } from '../05_Observe_Environment/profile.ts'
import { FiveWhys, GOAL_MAX, type Brief, type Control, type PlanStep, type WhyStep } from '../06_Make_Decisions/intent.ts'
import { controlHints, isPadFamily, type GlyphFamily } from './glyphs.ts'
import { GlyphKey } from './Hud.tsx'
import type { SiteModelHost, SiteModelLine, SiteModelProgress } from '../09_Cognition/siteModel.ts'
import type { SiteJobState } from '../09_Cognition/siteJob.ts'
import type { Nudge } from '../09_Cognition/tutorial.ts'
import type { LaneLine } from '../08_Swarm/team.ts'
import type { Chat, ChatTurn, Voice } from './onboarding/voice.ts'
import { CONCIERGE_NAME } from './onboarding/script.ts'
import { heardGoal } from './onboarding/heard.ts'

/** The Concierge's name (onboarding/script.ts), for any other surface that mentions them. */
export { CONCIERGE_NAME }

const SLOANE = {
  name: CONCIERGE_NAME,
  pronouns: 'they/them',
  /** How long a greeting stays open before settling into the chip (and how long a controller player,
   *  who cannot type, sees the name question). */
  settleMs: 8000,
  /** Ground covered, from any input, that counts as the first movement and puts an open card away. */
  settleMetres: 1,
  /** How long one of Sloane's unasked lines (a nudge from the mentor, 09_Cognition/tutorial.ts) stays open before the chip. */
  nudgeMs: 14000,
} as const

type View = 'ask' | 'greet' | 'help' | 'chip' | 'goal' | 'nudge'
type Mood = 'new' | 'back' | 'renamed' | 'skipped'

/** Keys that mean the player is under way: the open card steps aside. */
const MOVE_KEYS: ReadonlySet<string> = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyE'])

/** Goals offered as chips before the player types one: plain phrases the engine maps. */
const STARTERS = ['Make it night', 'Golden hour', 'Smoother', 'Fewer people', 'Show me around'] as const

/** The goal dialogue: no goal yet, a question on screen, or (questions over) the brief. `applied` are
 *  the immediate steps the host carried out, ticked in the card and the copyable brief. */
interface Dialogue { whys: FiveWhys | null; step: WhyStep | null; brief: Brief | null; applied: readonly Control[] }
/** Lanes shown under a brief before "and N more". */
const TEAM_ROWS = 6

/** How a reply in the conversation stands (onboarding/voice.ts ChatResult, `waiting` while it streams in, and `stopped`
 *  by the person's Stop). */
type TalkState = 'waiting' | 'said' | 'none' | 'slow' | 'held' | 'refused' | 'failed' | 'stopped'
/** The reply on the card: which ask it answers, how it stands, the words so far, and why it failed (a router's reason). */
interface Talk { readonly id: number; readonly state: TalkState; readonly text: string; readonly why: string }
/** Turns of the conversation kept for the visit (the model is shown the last of them, voice.ts CHAT_TURNS). */
const TALK_KEPT = 16
/** What Sloane says when no model answers this page: plainly that none does, and what they can still do. */
const NO_MODEL_LINE = 'No language model is answering this page yet, so I can’t chat. I can still change the city for you: try “make it night”.'
/** A model file small enough for a first visit, named in the hint beside the picker (it runs on a processor alone). */
const SMALL_MODEL_HINT = 'A small model file runs right in this page: a .gguf such as Qwen2.5 0.5B Instruct at Q4_K_M, about 0.4 GB.'
/** A page Ollama answers by default (localhost, 127.0.0.1 and 0.0.0.0 on any port; not [::1]). */
const LOOPBACK_PAGE = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?$/
/** The card's line for a reply. */
function talkLine(t: Talk | null): string {
  switch (t?.state) {
    case undefined: return ''
    case 'waiting': return t.text || '…'
    case 'said': return t.text
    case 'none': return NO_MODEL_LINE
    case 'slow': return 'The model took too long to answer. Ask again, or try something shorter.'
    case 'held': return 'I won’t repeat what the model answered: it didn’t pass the city’s screen. Ask me something else.'
    // The person's words failed the 14A screen: not engaged with, not repeated, not sent anywhere.
    case 'refused': return 'Let’s keep it to the city. What would you like it to do?'
    case 'failed': return 'The model couldn’t answer this time. Ask again in a moment.'
    case 'stopped': return 'Stopped. Say something else, or ask again.'
  }
}
const NO_GOAL: Dialogue = { whys: null, step: null, brief: null, applied: [] }

/** A dialogue given up front (a deep link, a server render): its goal and answers already in. */
function resume(goal: { text: string; answers?: readonly string[] } | undefined): Dialogue {
  const text = goal?.text.trim() ?? ''
  if (!text) return NO_GOAL
  const whys = new FiveWhys(text)
  for (const a of goal?.answers ?? []) whys.answer(a)
  const step = whys.next()
  return { whys, step, brief: step ? null : whys.brief(), applied: [] }
}

/** The registration number never breaks at its hyphens; the notice text itself stays verbatim. */
const ORC_REGISTRATION = 'TX 9-307-067'
const [ORC_BEFORE, ORC_AFTER] = ORC_NOTICE.split(ORC_REGISTRATION)

/** Card and chip positions per layout (full class strings, so Tailwind sees them). The HUD's matching
 *  geometry: wide frame 1.25 rem, minimap 13 rem bottom-left, bottom-centre capture hint ≈ 2.6 rem tall
 *  (4.4 rem with its key row) and enter prompt at 5 rem + 2.5 rem tall; compact frame 0.75 rem, minimap
 *  7 rem top-right with the speed chip (≈ 3.6 rem) under it while driving. Touch (TouchControls.tsx): the
 *  stick's zone 11.5 rem square 0.5 rem from the bottom-left corner (its right edge 12 rem in), and the buttons
 *  in the bottom-right, whose top and left edges the overlay publishes as --touch-top and --touch-left (the
 *  fallbacks stand for the frame before it has). Every touch card keeps clear of the buttons: held upright it
 *  ends above them; in landscape on foot it stands in the band between the stick and the buttons (on a narrow
 *  phone it gives up the stick's inner edge rather than shrink under 15.5 rem); at the wheel it stands over
 *  them. Upright a card starts 7.5 rem under the frame's top: under the minimap and the HUD's one panel beside it,
 *  with the first walk's strip, which ends level with the minimap (status chips below that line take no taps, and an
 *  open card lies over them). On a short screen every card scrolls inside its own height rather than run off the top
 *  (the controls list grows by the Menu's row on touch). The chip stands under the minimap and under the HUD's panels (their foot
 *  is --hud-bottom, published by the HUD), ending above the touch buttons; upright on foot the HUD's toasts start
 *  below it (--chip-bottom, published here), and at the wheel one toast stands with the panels and the chip below it. On a short touch screen in landscape it rises to end above the buttons when they reach up that far, and
 *  if that would meet the minimap it moves left of it, narrowing (its goal text truncates) to stay clear of the HUD's
 *  left column (17 rem of status chips and toasts, which also keeps it off the stick) and, level with the header and
 *  readout (--hud-row-bottom), of their right edge (--hud-right), down to 10.5 rem: under about 600 px across that
 *  floor can still reach a toast.
 *  Text size (access.ts): the card and chip sit inside the overlay's zoom, which multiplies every length in them, so
 *  each length measured in the window's own pixels (the published edges above, the viewport's height) is divided by
 *  --ui-zoom first, or at 200 % the card would clear the buttons by twice their height and run off the screen.
 *  Which placements apply follows the touch overlay being on screen (`overlay`), not the glyphs: a pad paired with a
 *  phone shows its glyphs while the buttons stay.
 *  Desktop: a column from just below the centre of view down to the HUD frame. The card stands at its foot
 *  on a spacer that clears the bottom-centre prompts; in a short window the spacer gives way first (down to
 *  the capture hint, which has its key row only under the HUD's ROOMY query, repeated here), so the card
 *  stays below the centre unless it is taller than the whole column. */
const WIDE_COLUMN = 'absolute top-[calc(50%+1rem)] bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-1/2 flex w-[min(38rem,max(22rem,calc(100%_-_30.5rem)))] -translate-x-1/2 flex-col justify-end'
/** The same column while the first walk's card stands on the right of a wide screen (onboarding/FirstWalk.tsx AT.wide: 20
 *  rem wide, 1.25 rem in): it spans from the minimap's clearance to 0.75 rem short of that card, centred there up to 38
 *  rem, so the two stand side by side instead of the card lying over the right end of Sloane's (her Continue button
 *  among it) on any window under about 1,300 px across. It applies from 60 rem across (besideRoom, at the text size's zoom), where at least
 *  22.75 rem is left; in a narrower window the walk's card steps aside while this card is open instead. */
const WIDE_BESIDE = 'absolute top-[calc(50%+1rem)] bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-[15.25rem] right-[calc(max(1.25rem,env(safe-area-inset-right))_+_20.75rem)] mx-auto flex w-auto max-w-[38rem] flex-col justify-end'
const WIDE_SPACER = 'h-[8.5rem] min-h-[3.25rem] shrink [@media(min-width:1100px)_and_(min-height:600px)]:min-h-[5rem]'
const CARD_AT = {
  tall: 'top-[calc(max(0.75rem,env(safe-area-inset-top))+7.5rem)] right-[max(0.75rem,env(safe-area-inset-right))] left-[max(0.75rem,env(safe-area-inset-left))] mx-auto max-h-[calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(0.75rem,env(safe-area-inset-top))_-_7.5rem_-_max(0.75rem,env(safe-area-inset-bottom)))] max-w-[28rem] overflow-y-auto overscroll-contain',
  tallTouch: 'top-[calc(max(0.75rem,env(safe-area-inset-top))+7.5rem)] right-[max(0.75rem,env(safe-area-inset-right))] left-[max(0.75rem,env(safe-area-inset-left))] mx-auto max-h-[calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(0.75rem,env(safe-area-inset-top))_-_7.5rem_-_calc(var(--touch-top,0.75rem)_/_var(--ui-zoom,1))_-_0.5rem)] max-w-[28rem] overflow-y-auto overscroll-contain',
  short: 'bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-[max(calc(env(safe-area-inset-left,0px)+0.75rem),min(calc(env(safe-area-inset-left,0px)+12.5rem),calc(100%_-_calc(var(--touch-left,12rem)_/_var(--ui-zoom,1))_-_16rem)))] right-[calc(calc(var(--touch-left,12rem)_/_var(--ui-zoom,1))_+_0.5rem)] mx-auto max-h-[calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(0.75rem,env(safe-area-inset-bottom))_-_max(0.75rem,env(safe-area-inset-top)))] max-w-[28rem] overflow-y-auto overscroll-contain',
  shortDriving: 'bottom-[calc(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1))_+_0.5rem)] left-[max(calc(env(safe-area-inset-left,0px)+0.75rem),min(calc(env(safe-area-inset-left,0px)+12.5rem),calc(100%_-_max(0.75rem,env(safe-area-inset-right))_-_15.5rem)))] right-[max(0.75rem,env(safe-area-inset-right))] mx-auto max-h-[calc(calc(100dvh_/_var(--ui-zoom,1))_-_calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1))_-_0.5rem_-_max(0.75rem,env(safe-area-inset-top)))] max-w-[28rem] overflow-y-auto overscroll-contain',
  shortRaised: 'bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+4.5rem)] left-1/2 max-h-[calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(0.75rem,env(safe-area-inset-bottom))_-_4.5rem_-_max(0.75rem,env(safe-area-inset-top)))] w-[min(28rem,calc(100%_-_26rem_-_env(safe-area-inset-left,0px)_-_env(safe-area-inset-right,0px)))] min-w-[18rem] -translate-x-1/2 overflow-y-auto overscroll-contain',
} as const
const CHIP_AT = {
  wide: 'bottom-[calc(max(1.25rem,env(safe-area-inset-bottom))+13.75rem)] left-[max(1.25rem,env(safe-area-inset-left))] max-w-[18rem]',
  compact: 'right-[max(0.75rem,env(safe-area-inset-right))] max-w-[18rem]',
  shortTouch: '[--chip-top:min(calc(max(0.75rem,env(safe-area-inset-top))_+_7.5rem),calc(calc(100dvh_/_var(--ui-zoom,1))_-_calc(var(--touch-top,0px)_/_var(--ui-zoom,1))_-_2.5rem))] [--chip-right:calc(max(0.75rem,env(safe-area-inset-right))_+_clamp(0rem,calc((max(0.75rem,env(safe-area-inset-top))_+_7.25rem_-_var(--chip-top))_*_100),7.5rem))] [--chip-left:max(calc(max(0.75rem,env(safe-area-inset-left,0px))_+_17.5rem),min(calc(calc(var(--hud-right,0px)_/_var(--ui-zoom,1))_+_0.5rem),calc(max(0.75rem,env(safe-area-inset-left,0px))_+_17.5rem_+_clamp(0px,calc((calc(var(--hud-row-bottom,0px)_/_var(--ui-zoom,1))_+_0.25rem_-_var(--chip-top))_*_10000),100vw))))] top-(--chip-top) right-(--chip-right) max-w-[max(10.5rem,min(18rem,calc(100%_-_var(--chip-right)_-_var(--chip-left))))]',
} as const
/** The compact chip's top (inline, not a class, because the same expression is published as --chip-bottom): under
 *  the minimap, or the speed chip at the wheel, and under the HUD's panels (--hud-bottom, from Hud.tsx) when they
 *  reach lower, as a readout with a device line does on an upright phone, but always ending above the touch buttons
 *  (where both cannot hold it stands over a panel, which takes no taps, never over a button). */
const CHIP_TOP = {
  /** On a short touch screen in landscape while the first walk's card is up between the thumbs (onboarding/FirstWalk.tsx
   *  AT.between, `beside` here): CHIP_AT.shortTouch's own top, unless the walk card's band, from 10.5 rem under the top
   *  inset down to the HUD's chips at the foot (--hud-foot, Hud.tsx), is short of 8 rem (a large text size, a short
   *  screen, captions or a shop's chip at the foot). Then the chip moves up to the top row, over the HUD's header and
   *  readout, which take no taps, and the walk's card rises to stand under it. Both read the same band through the
   *  same step (0 while the band holds 8 rem, else the screen's height), so they agree without a word between them;
   *  the step reads the HUD's foot latched at its highest (--hud-foot-peak, footPeak.ts), so captions coming and going
   *  never flip the chip from under a thumb. The chip publishes its foot as --chip-bottom for the card. */
  walk: 'max(max(0.75rem, env(safe-area-inset-top)), calc(min(calc(max(0.75rem, env(safe-area-inset-top)) + 7.5rem), calc(calc(100dvh / var(--ui-zoom, 1)) - calc(var(--touch-top, 0px) / var(--ui-zoom, 1)) - 2.5rem)) - clamp(0px, calc((8rem - calc(calc(100dvh / var(--ui-zoom, 1)) - max(0.75rem, env(safe-area-inset-top)) - 10.5rem - max(max(0.75rem, env(safe-area-inset-bottom)), calc(calc(var(--hud-foot-peak, var(--hud-foot, 0px)) / var(--ui-zoom, 1)) + 0.5rem)))) * 10000), 100vh)))',
  foot: 'min(max(calc(max(0.75rem, env(safe-area-inset-top)) + 7.5rem), calc(calc(var(--hud-bottom, 0px) / var(--ui-zoom, 1)) + 0.5rem)), calc(calc(100dvh / var(--ui-zoom, 1)) - calc(var(--touch-top, 0px) / var(--ui-zoom, 1)) - 2.5rem))',
  driving: 'min(max(calc(max(0.75rem, env(safe-area-inset-top)) + 11.75rem), calc(calc(var(--hud-bottom, 0px) / var(--ui-zoom, 1)) + 0.5rem)), calc(calc(100dvh / var(--ui-zoom, 1)) - calc(var(--touch-top, 0px) / var(--ui-zoom, 1)) - 2.5rem))',
} as const

/** A media query as a stable external store (same queries as the HUD's compact layout). */
function mediaStore(query: string) {
  let list: MediaQueryList | null = null
  const media = () => (list ??= window.matchMedia(query))
  return {
    subscribe(onChange: () => void) {
      const m = media()
      m.addEventListener('change', onChange)
      return () => m.removeEventListener('change', onChange)
    },
    matches: () => media().matches,
    server: () => false,
  }
}
const SMALL = mediaStore('(max-width: 639px), (max-height: 499px)')
const SHORT = mediaStore('(max-height: 499px)')
const LANDSCAPE = mediaStore('(orientation: landscape)')
/** Wide enough for Sloane's card beside the first walk's: 60 rem at 100 % text (FirstWalk.tsx steps its card aside below it). */
export const BESIDE_ROOM_PX = 960
/**
 * The same room at a text size's zoom (access.ts, `--ui-zoom`): both cards and every measure between them are inside
 * the zoom, so at 200 % they need twice the window. One query for both sides; one store per zoom.
 */
export function besideRoomQuery(zoom: number): string {
  return `(min-width: ${Math.round(BESIDE_ROOM_PX * Math.max(1, zoom))}px)`
}
const ROOM_STORES = new Map<string, ReturnType<typeof mediaStore>>()
export function besideRoom(zoom: number): ReturnType<typeof mediaStore> {
  const query = besideRoomQuery(zoom)
  let store = ROOM_STORES.get(query)
  if (!store) ROOM_STORES.set(query, (store = mediaStore(query)))
  return store
}

function isEditable(t: EventTarget | null): boolean {
  if (!t || typeof t !== 'object') return false
  const el = t as { isContentEditable?: boolean; tagName?: unknown }
  if (el.isContentEditable) return true
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export interface ConciergeProps {
  /** Show the Concierge (pass false while the boot veil covers the page, the HUD is hidden or the terminal is open). */
  visible: boolean
  /** The saved profile (loadProfile()), or null on a first visit. */
  profile: Profile | null
  /** Called once the player has named themselves; the profile is already saved. */
  onProfile(p: Profile): void
  /** Control glyphs matching the input in use (snapshot.supplier.glyphs). */
  family: GlyphFamily
  /** Optional: the touch overlay is on screen (snapshot.supplier.touch); the card and chip keep clear of its buttons.
   *  Defaults to touch glyphs. */
  overlay?: boolean
  driving: boolean
  /** Optional: the HUD's night glass (snapshot.customer.daylight < 0.35). */
  dark?: boolean
  /** Optional: ms before a greeting settles into the chip (default 8000; tests shorten it). */
  settleMs?: number
  /** Optional: metres walked plus driven so far (snapshot.experience). Its growth is movement from any
   *  input, a controller's stick included (which sends no key events), and puts an open card away. */
  travelled?: number
  /** Optional: the host applies an immediate plan step (time, quality, audio) and says whether it did.
   *  Without it every step is shown as a plan. */
  onIntent?(step: PlanStep): boolean
  /** Optional: open on the goal dialogue instead of the greeting, with this goal (and any answers) already
   *  given — a deep link, or a server render of that view. Steps the answers have already reached are shown
   *  as the plan, not applied: the host applies only what the player reaches through the dialogue. */
  goal?: { text: string; answers?: readonly string[] }
  /** Optional: the host opens the wardrobe (Customizer.tsx); the chip and the full list then offer it. */
  onLook?(): void
  /**
   * Optional: a line Sloane says unasked (the mentor's nudge, 09_Cognition/tutorial.ts): shown as the card when it is a
   * new one (its id changed) and no question or goal is open, then settled into the chip like a greeting. Its text may
   * change while it shows (the model's rewording arriving).
   */
  nudge?: Nudge | null
  /** Optional: the player opened the goal dialogue (the mentor counts it as talking to Sloane). */
  onGoal?(): void
  /** Optional: the player sent a goal in their own words (the first walk's voice stage counts it as talking to Sloane). */
  onGoalSent?(text: string): void
  /** Optional: Sloane's spoken voice (onboarding/speaker.ts): called with each line the card shows, as plain words. */
  onSay?(text: string): void
  /**
   * Optional: words the visitor said near the open microphone (the on-device recogniser's final transcript,
   * 04_Connect_Hardware/microphone.ts beside 08_Swarm/recruitment.ts), each with its own id; a recruitment request
   * never arrives here. An open question takes them as its answer and the open goal prompt as the goal; otherwise only
   * a line that names Sloane first ("Sloane, make it night") opens the goal dialogue with the rest (onboarding/heard.ts),
   * so the room's talk is never a goal. Each utterance is taken once.
   */
  heard?: { id: number; text: string } | null
  /**
   * Optional: Sloane's own words (onboarding/voice.ts sloaneVoice): a brief's sentence is put to it once and shown when
   * it arrives; the plan under it, the dispatch and what is spoken stay the planner's. Null: the planner's words.
   */
  reword?: Voice | null
  /**
   * Optional: Sloane in conversation (onboarding/voice.ts sloaneChat, over the page's mind): a goal that is talk
   * (intent.ts Brief.chat) gets the model's reply, streamed onto the card, and the field stays open for the next turn.
   * Null: no model can be asked, and talk gets the plain line saying so.
   */
  chat?: Chat | null
  /** Optional: opens the picker for a model file kept in this page (Menu › Model file), offered when no model answers. */
  onPickModel?(): void
  /** Optional: why this page cannot run a model file (the browser lacks a piece), said in place of the picker. */
  noPageModel?: string | null
  /**
   * Optional: the model this site serves beside the page (09_Cognition/siteModel.ts, built by App.tsx), offered when no
   * model answers: one tap downloads it, checks it, keeps it and asks the last turn again. The page may get it by itself
   * too (09_Cognition/siteAuto.ts): either way its one job (siteJob.ts) shows its progress and its Stop here, on the
   * conversation, on the card's other views and on the chip. Null: nothing to offer.
   */
  siteModel?: SiteModelHost | null
  /** Optional: the lanes of the team the host opened for the brief (08_Swarm/team.ts lines), shown under it as they run. */
  lanes?: readonly LaneLine[] | null
  /** Optional: the first walk's card is on screen (it stands on the right of a wide screen): the wide column keeps left of it. */
  beside?: boolean
  /** Optional: the text size's zoom (access.ts scale / 100), for the room the two cards need side by side. */
  zoom?: number
  /** Optional: told whether Sloane's card (not her chip) is on screen, so the first walk's card can step aside for it in a narrow window. */
  onOpen?(open: boolean): void
}

export function Concierge({ visible, profile, onProfile, family, overlay = family === 'touch', driving, dark = false, settleMs = SLOANE.settleMs, travelled, onIntent, goal, onLook, nudge = null, onGoal, onGoalSent, onSay, heard = null, reword = null, chat = null, onPickModel, noPageModel = null, siteModel = null, lanes = null, beside = false, zoom = 1, onOpen }: ConciergeProps) {
  const small = useSyncExternalStore(SMALL.subscribe, SMALL.matches, SMALL.server)
  const room = besideRoom(zoom)
  const roomy = useSyncExternalStore(room.subscribe, room.matches, room.server)
  const short = useSyncExternalStore(SHORT.subscribe, SHORT.matches, SHORT.server)
  const landscape = useSyncExternalStore(LANDSCAPE.subscribe, LANDSCAPE.matches, LANDSCAPE.server)
  const [view, setView] = useState<View>(() => (goal ? 'goal' : profile ? 'greet' : 'ask'))
  const [mood, setMood] = useState<Mood>(() => (profile ? 'back' : 'new'))
  /** The name given this session: the parent's `profile` may lag it by a render. */
  const [given, setGiven] = useState('')
  const [skipped, setSkipped] = useState(false)
  /** The one text field: the name, then a goal, then each answer. */
  const [draft, setDraft] = useState('')
  const [dialogue, setDialogue] = useState<Dialogue>(() => resume(goal))
  /** The brief's sentence in Sloane's own words, once the mind has answered for this brief (the brief itself names it:
   *  a later brief with the same sentence starts from the planner's words again, whatever the provider is by then). */
  const [worded, setWorded] = useState<{ brief: Brief; text: string } | null>(null)
  // One ask a brief: the planner's sentence shows (and is spoken) meanwhile, and a new brief or a card that goes ends the ask.
  useEffect(() => {
    const b = dialogue.brief
    // Talk is answered by the conversation below, never reworded.
    if (!reword || !b || b.chat) return
    const ctl = new AbortController()
    const root = b.root
    reword.say(root, ctl.signal).then((text) => { if (!ctl.signal.aborted && text && text !== root) setWorded({ brief: b, text }) }, () => {})
    return () => ctl.abort()
  }, [reword, dialogue.brief])
  /** The conversation: the reply on the card, the ask under way (a newer ask ends it) and the turns of the visit so far. */
  const [talk, setTalk] = useState<Talk | null>(null)
  const [asking, setAsking] = useState<{ id: number; turns: readonly ChatTurn[] } | null>(null)
  const turnsRef = useRef<readonly ChatTurn[]>([])
  const talkId = useRef(0)
  // One ask a turn: the words stream onto the card as they come; a newer turn ends it. A card that settles into the
  // chip lets the reply finish (it is kept for the next turn); nothing here ever times it out (voice.ts sloaneChat).
  useEffect(() => {
    if (!asking || !chat) return
    const id = asking.id
    const ctl = new AbortController()
    const put = (t: Partial<Talk>) => { if (!ctl.signal.aborted) setTalk((v) => (v?.id === id ? { ...v, ...t } : v)) }
    chat.reply(asking.turns, ctl.signal, (soFar) => put({ text: soFar })).then((r) => {
      if (ctl.signal.aborted) return
      if (r.kind === 'said') {
        turnsRef.current = [...turnsRef.current, { who: 'sloane' as const, text: r.text }].slice(-TALK_KEPT)
        put({ state: 'said', text: r.text, why: '' })
        return
      }
      // Words the screen refused are not kept as a turn: no later ask carries them.
      if (r.kind === 'refused' && turnsRef.current.at(-1)?.who === 'you') turnsRef.current = turnsRef.current.slice(0, -1)
      put({ state: r.kind, text: '', why: r.kind === 'none' || r.kind === 'failed' ? r.why : '' })
    }, (e: unknown) => put({ state: 'failed', text: '', why: e instanceof Error ? e.message : String(e) }))
    return () => ctl.abort()
  }, [chat, asking])
  /** Puts the turns so far to Sloane (the last one the person's); with no conversation to ask, the plain line at once. */
  const askTurns = (turns: readonly ChatTurn[]) => {
    talkId.current += 1
    const id = talkId.current
    setTalk({ id, state: chat ? 'waiting' : 'none', text: '', why: '' })
    setAsking(chat ? { id, turns } : null)
  }
  const talkOn = (text: string) => {
    turnsRef.current = [...turnsRef.current, { who: 'you' as const, text }].slice(-TALK_KEPT)
    askTurns(turnsRef.current)
  }
  /** A reply still on its way: the next turn waits for it or for Stop, so a second message never cuts short a model
   *  that is still loading for the first (a new ask would end that load and start it again). */
  const replying = talk?.state === 'waiting'
  /** The last reply the person has had on the card (shown and said); one that came while the card was away is unseen. */
  const [seenTalk, setSeenTalk] = useState(0)
  const unseen = talk !== null && talk.state !== 'waiting' && talk.id !== seenTalk
  /** The brief on the clipboard, or shown to copy by hand where the clipboard is out of reach. */
  const [copied, setCopied] = useState<'no' | 'yes' | 'shown'>('no')
  /** Bumped whenever a card opens or a question changes: restarts the settle timer and the focus effect. */
  const [epoch, setEpoch] = useState(0)
  const cardRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** The next ask or goal card takes focus even on touch (the player tapped for it, so a keyboard may rise). */
  const focusNext = useRef(false)
  /** Back to the field after a button that goes away when pressed (Stop, Ask again): focus never falls to the page, where
   *  the next letter typed would be a step that puts the card away. */
  const refocus = () => {
    focusNext.current = true
    setEpoch((n) => n + 1)
  }
  /** The last turn again (after a model file was chosen, a server started, or a slow answer). */
  const askAgain = () => {
    if (turnsRef.current.at(-1)?.who === 'you') askTurns(turnsRef.current)
    refocus()
  }
  /** The person's Stop: the ask ends (a model loading in this page for it stops loading, as any stop of an answer does). */
  const stopTalk = () => {
    setAsking(null)
    setTalk((v) => (v && v.state === 'waiting' ? { ...v, state: 'stopped', text: '', why: '' } : v))
    refocus()
  }
  /** The site's model on offer (siteModel.offer): undefined until the card first needs it, null where there is none. */
  const [site, setSite] = useState<SiteModelLine | null | undefined>(undefined)
  /** Getting it (siteJob.ts): the page's one job, started by the tap here or by the page itself, whoever reads it. */
  const job = useSyncExternalStore(siteModel?.job.subscribe ?? NO_SUBSCRIBE, siteModel?.job.state ?? NO_JOB, NO_JOB)
  /** How far it has come while it runs, or null. */
  const getting: SiteModelProgress | null = job?.phase === 'running' ? job : null
  /** Why the last try to get it ended short (a plain sentence), or ''. */
  const gotWhy = job?.phase === 'failed' ? job.why : ''
  /** The last tapped try that ended short whose reason the card has shown: one that came while the card was away keeps
   *  the conversation for it (a try the page started by itself says why in a toast, and never opens the card). */
  const [whySeenId, setWhySeenId] = useState(0)
  const whySeen = !(job?.phase === 'failed' && job.how === 'tap' && job.id !== whySeenId)
  /** The model has just arrived and the last turn is asked again: the wait says it is starting, not thinking. */
  const [starting, setStarting] = useState(false)
  /** Whether the card is on a conversation, read when a download ends minutes after the render that started it. */
  const onChat = useRef(false)
  useEffect(() => { onChat.current = dialogue.brief?.chat === true })
  const offering = talk?.state === 'none' && siteModel !== null && !noPageModel
  // Asked again at each conversation that ends with no model, and after each try to get it: whether the site serves it
  // (the host asks the manifest once a visit, again only after the site could not be reached) and whether this
  // browser keeps it now, so the button never says "kept" of a copy that has gone, nor hides an offer for good.
  const noneOf = talk?.id
  const fetchingSite = getting !== null
  useEffect(() => {
    if (!offering || fetchingSite || !siteModel) return
    let live = true
    siteModel.offer().then((o) => { if (live) setSite(o) }, () => { if (live) setSite(null) })
    return () => { live = false }
  }, [offering, fetchingSite, noneOf, siteModel])
  // Adjusted while rendering: the start is over once the answer to the turn asked again has come (or none could).
  if (starting && talk?.state !== 'waiting') setStarting(false)
  /** After a button that goes away (the offer, Stop) or a download that ends: back to the field, as refocus does, but
   *  never on touch, where no stray key can put the card away and an unasked on-screen keyboard would cover the bar. */
  const refocusKeys = () => {
    if (family !== 'touch') refocus()
  }
  /** When a download ends, minutes after the tap: back to the field only if focus is still on the card or has fallen
   *  to the page, never taken from a control elsewhere (the HUD, the first walk's card). */
  const refocusAtEnd = () => {
    const a = document.activeElement
    if (!a || a === document.body || cardRef.current?.contains(a)) refocusKeys()
  }
  /** The tap: the site's model downloaded, checked and kept (or, kept already, chosen); its end is met below. */
  const getSite = () => {
    if (!siteModel || getting) return
    refocusKeys()
    void siteModel.job.start('tap')
  }
  // How each job ended, met once, whoever started it: kept, so the offer says so and a conversation still on the card
  // is asked again (a goal typed since is the visitor's next thing, and an answer to an old turn would come where
  // nothing shows it); and back to the field after the visitor's own tap.
  const endMet = useRef(0)
  const meetEnd = useEffectEvent((end: SiteJobState) => {
    if (end.phase === 'done') {
      setSite((v) => (v ? { ...v, kept: true } : v))
      if (onChat.current && turnsRef.current.at(-1)?.who === 'you') {
        setStarting(true)
        askTurns(turnsRef.current)
      }
    }
    if (end.how === 'tap') refocusAtEnd()
  })
  useEffect(() => {
    if (!job || job.phase === 'running' || job.id === endMet.current) return
    endMet.current = job.id
    meetEnd(job)
  }, [job])
  /** Stop while it downloads: nothing is kept, and the offer is back. Once the file is handed to the copy it runs to
   *  its end (it is kept and chosen): a Stop still on screen for that frame does nothing (siteJob.ts stop). */
  const stopGetting = () => {
    if (siteModel?.job.stop('person')) refocusKeys()
  }
  // Previous props, for adjusting state while rendering (React's pattern for reacting to a prop change).
  const [seenProfile, setSeenProfile] = useState(profile)
  const [seenDriving, setSeenDriving] = useState(driving)
  const [seenNudge, setSeenNudge] = useState(0)

  const name = given || profile?.name || ''
  // The line as plain words, for Sloane's voice (onSay): said once per line shown, never for the chip or the full list.
  // A nudge is one line however it is reworded (the script's words are said; a model's rewording changes the card
  // only), and a card hidden and shown again (the console, H) is the same line, not a new one: only the chip or the
  // full list in between lets the same words be said again.
  // A reply is said once it is whole (never word by word as it streams).
  const talking = view === 'goal' && dialogue.brief?.chat === true
  const spoken = talking ? (talk && talk.state !== 'waiting' ? talkLine(talk) : '') : spokenLine(view, mood, name, nudge, dialogue)
  const spokenKey = view === 'nudge' && nudge ? `nudge:${nudge.id}` : spoken
  // Adjusted while rendering: a reply is seen once the card shows it.
  if (visible && talking && talk && talk.state !== 'waiting' && talk.id !== seenTalk) setSeenTalk(talk.id)
  // Adjusted while rendering: so is the reason a download ended short, once the card shows it.
  if (!whySeen && job && visible && talking && talk?.state === 'none' && gotWhy !== '' && getting === null) setWhySeenId(job.id)
  const sayRef = useRef(onSay)
  const saidRef = useRef('')
  useEffect(() => { sayRef.current = onSay }, [onSay])
  useEffect(() => {
    if (!spokenKey) { saidRef.current = ''; return }
    if (!visible || spokenKey === saidRef.current) return
    saidRef.current = spokenKey
    sayRef.current?.(spoken)
  }, [visible, spokenKey, spoken])
  const open = (v: View) => {
    setView(v)
    setEpoch((n) => n + 1)
  }
  const settle = () => setView('chip')
  const skip = () => {
    inputRef.current?.blur()
    setSkipped(true)
    setMood('skipped')
    open('greet')
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const clean = sanitizeName(draft)
    // Blur first: the game must receive keys the moment the card changes.
    inputRef.current?.blur()
    if (!clean) {
      if (name) settle() // an emptied rename changes nothing
      else skip()
      return
    }
    const p: Profile = { name: clean, seed: seedFromName(clean) }
    saveProfile(p)
    const renamed = name !== '' && name !== clean
    setGiven(clean)
    setMood(renamed ? 'renamed' : name ? 'back' : 'new')
    onProfile(p)
    open('greet')
  }
  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelAsk()
    }
  }
  /** Skip on a first visit; on a rename, leave the name as it was. */
  const cancelAsk = () => {
    if (!name) return skip()
    inputRef.current?.blur()
    settle()
  }
  const askForName = () => {
    focusNext.current = true
    setDraft(name)
    open('ask')
  }

  // The goal dialogue. The engine lives in state as an opaque handle and is only ever advanced from an
  // event, after which a fresh Dialogue is set; renders read `step` and `brief`, never the engine.
  /** Runs the dialogue on: the next question, or — questions over — the brief, every immediate step not
   *  yet applied offered to the host first. */
  const advance = (whys: FiveWhys, applied: readonly Control[]) => {
    const step = whys.next()
    let done = applied
    if (!step) {
      const fresh = whys.brief().plan.filter((s) => s.immediate && !applied.includes(s.control) && onIntent?.(s) === true).map((s) => s.control)
      done = fresh.length ? [...applied, ...fresh] : applied
    }
    const brief = step ? null : whys.brief(done)
    // Talk while a reply is still on its way (however it got here: typed, heard, after Another goal) waits in the field.
    if (brief?.chat && replying) {
      setDraft(brief.goal)
      return
    }
    setDialogue({ whys, step, brief, applied: done })
    setCopied('no')
    setDraft('')
    // Talk is the next turn of the conversation, and its field stays up for the turn after (on touch too).
    if (brief?.chat) {
      talkOn(brief.goal)
      focusNext.current = true
    } else if (family === 'touch') inputRef.current?.blur() // on touch the chips are the way to answer: let the on-screen keyboard drop between questions
    setEpoch((n) => n + 1)
  }
  /** `chatting`: a conversation is on the card, so words that map to nothing are its next turn (intent.ts FiveWhys). */
  const startGoal = (text: string, chatting = false) => {
    const goalText = text.trim()
    if (!goalText) return
    advance(new FiveWhys(goalText, { chatting }), [])
    onGoalSent?.(goalText)
  }
  const reply = (text: string) => {
    // A reply still on its way: the words wait in the field (a heard line too), to go with Send once it lands.
    if (dialogue.brief?.chat && replying) {
      setDraft((d) => (d.trim() ? d : text))
      return
    }
    if (dialogue.whys && dialogue.step) {
      dialogue.whys.answer(text)
      advance(dialogue.whys, dialogue.applied)
    } else startGoal(text, dialogue.brief?.chat === true)
  }
  const submitGoal = (e: FormEvent) => {
    e.preventDefault()
    if (draft.trim()) reply(draft)
  }
  /** Esc: a question goes back to the goal (kept in the field); the goal prompt and the brief close. */
  const backOut = () => {
    if (dialogue.whys && dialogue.step) {
      setDraft(dialogue.whys.brief().goal)
      setDialogue(NO_GOAL)
      setEpoch((n) => n + 1)
      return
    }
    inputRef.current?.blur()
    settle()
  }
  const onGoalKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      backOut()
    }
  }
  const openGoal = () => {
    focusNext.current = true
    // A conversation whose reply is still on its way, or came while the card was away, is opened again as it stands;
    // so is one whose model is still downloading, or whose download ended short while the card was away.
    if (dialogue.brief?.chat && (replying || unseen || getting !== null || (!whySeen && talk?.state === 'none'))) {
      open('goal')
      onGoal?.()
      return
    }
    setDraft('')
    setDialogue(NO_GOAL)
    setCopied('no')
    open('goal')
    onGoal?.()
  }
  // Words the visitor said (heard.ts decides what of them is Sloane's): an open question or goal prompt takes the line,
  // else a line that names Sloane first opens the goal dialogue with the rest. After the render, so the host's hooks
  // (onGoal) run outside it; each utterance once, by its id, and none while the card is hidden.
  const heardRef = useRef(0)
  const takeHeard = useEffectEvent((text: string) => {
    if (!visible) return
    const open = view === 'goal' && (!dialogue.brief || dialogue.brief.chat === true)
    const said = heardGoal(text, open)
    if (said === null) return
    if (open) reply(said)
    else if (dialogue.brief?.chat && replying) {
      // "Sloane, …" from the chip while a reply is on its way: the conversation opens as it stands, the words in its field.
      openGoal()
      setDraft(said)
    } else {
      openGoal()
      startGoal(said)
    }
  })
  useEffect(() => {
    if (!heard || heard.id === heardRef.current) return
    heardRef.current = heard.id
    takeHeard(heard.text)
  }, [heard])
  const copyBrief = () => {
    const md = dialogue.brief?.markdown
    if (!md) return
    const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (!clip?.writeText) { setCopied('shown'); return }
    clip.writeText(md).then(() => setCopied('yes'), () => setCopied('shown'))
  }

  // A profile that arrives after mount (a host that loads it late) answers the first question: welcome back.
  if (profile !== seenProfile) {
    setSeenProfile(profile)
    if (profile && !seenProfile && !given && view === 'ask') {
      setMood('back')
      open('greet')
    }
  }
  // Getting into or out of a car is movement: the card steps aside.
  if (driving !== seenDriving) {
    setSeenDriving(driving)
    if (view !== 'chip') settle()
  }
  // A new line from the mentor opens the card, unless the player is mid-question or mid-goal (it waits its turn: the
  // next line comes with its own id). A nudge is never shown twice.
  if (nudge && nudge.id !== seenNudge) {
    setSeenNudge(nudge.id)
    if (view === 'chip' || view === 'greet' || view === 'help' || view === 'nudge') open('nudge')
  }

  // Greetings settle into the chip; so does the name question for a controller player, who may have no
  // keyboard — unless they have started typing (typing into the field leaves the family unchanged).
  const padAsk = view === 'ask' && isPadFamily(family) && draft === ''
  useEffect(() => {
    if (!visible || (view !== 'greet' && view !== 'nudge' && !padAsk)) return
    const id = window.setTimeout(() => setView('chip'), view === 'nudge' ? Math.max(settleMs, SLOANE.nudgeMs * (settleMs / SLOANE.settleMs)) : settleMs)
    return () => window.clearTimeout(id)
  }, [visible, view, padAsk, family, epoch, settleMs])

  // First movement puts the card away: walking keys (not typed into a field) or a touch outside the card
  // (the stick, the look drag, a car button). Mouse clicks and drags are looking, not moving. Esc dismisses
  // (in the goal dialogue, it backs out one step). Space on one of the card's own buttons (a chip reached
  // with Tab) presses it, as Enter does; it is not a step.
  const onWindowKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing || isEditable(e.target)) return
    if (e.key === 'Escape') {
      if (view === 'ask') cancelAsk()
      else if (view === 'goal') backOut()
      else settle()
    } else if (MOVE_KEYS.has(e.code)) {
      const pressing = e.code === 'Space' && e.target instanceof HTMLButtonElement && cardRef.current?.contains(e.target)
      if (!pressing) settle()
    }
  })
  const onWindowPointer = useEffectEvent((e: PointerEvent) => {
    if (e.pointerType === 'mouse' || cardRef.current?.contains(e.target as Node)) return
    settle()
  })
  // Ground covered since the card opened (or came back into view) is movement whatever the input. A
  // half-typed name, goal or answer is never thrown away.
  const typing = (view === 'ask' || view === 'goal') && draft !== ''
  const travelFrom = useRef(Number.NaN)
  useEffect(() => { travelFrom.current = Number.NaN }, [visible, view, epoch])
  useEffect(() => {
    if (!visible || view === 'chip' || typing || travelled === undefined || !Number.isFinite(travelled)) return
    if (Number.isNaN(travelFrom.current)) travelFrom.current = travelled
    else if (travelled - travelFrom.current >= SLOANE.settleMetres) setView('chip')
  }, [visible, view, typing, travelled])

  const listening = visible && view !== 'chip'
  useEffect(() => {
    if (!listening) return
    const onKey = (e: KeyboardEvent) => onWindowKey(e)
    const onPointer = (e: PointerEvent) => onWindowPointer(e)
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer, true)
    }
  }, [listening])

  // Zero-click: the name field is focused as soon as the question shows, so typing just works — and so
  // is the goal field for each question. Not on touch unless asked for (an unrequested on-screen keyboard
  // would cover the city), and never taken from another field (the terminal). Only when the question
  // opens: a later input-family change must not pull the keyboard back from the game.
  const focusField = useEffectEvent(() => {
    const requested = focusNext.current
    focusNext.current = false
    if (family === 'touch' && !requested) return
    const el = inputRef.current
    const active = document.activeElement
    if (!el || (active && active !== el && isEditable(active))) return
    el.focus({ preventScroll: true })
  })
  const fielded = view === 'ask' || (view === 'goal' && (dialogue.brief === null || dialogue.brief.chat === true))
  useEffect(() => {
    if (visible && fielded) focusField()
  }, [visible, fielded, epoch])
  // Whether the card is up (any view but the chip), for the first walk's card; back to closed when this goes.
  const opened = visible && view !== 'chip'
  useEffect(() => {
    if (!onOpen) return
    onOpen(opened)
    return () => onOpen(false)
  }, [opened, onOpen])

  const compact = small || overlay
  const layout = !compact ? 'wide' : short ? 'short' : 'tall'
  // The chip under the minimap publishes its foot as --chip-bottom, and upright on foot the HUD's toasts start below
  // it rather than pass under it; sideways during the first walk the walk's card stands under it (CHIP_TOP.walk). A
  // ref callback (a new one when the top changes), cleaned up when the chip goes.
  const sideways = layout === 'short' && overlay && landscape
  const chipTop = layout === 'wide' || sideways ? null : CHIP_TOP[layout === 'tall' && driving ? 'driving' : 'foot']
  const walkTop = sideways && beside && !driving ? CHIP_TOP.walk : null
  const footOf = chipTop ?? walkTop
  const chipRef = useCallback((el: HTMLElement | null) => {
    if (!el || !footOf) return
    const root = document.documentElement.style
    // Its head too (--chip-head): on a phone held upright the first walk's open card stands above the chip, over the
    // HUD's header, where the band under it is too short (onboarding/FirstWalk.tsx AT.touch), and never over it.
    const publish = () => {
      root.setProperty('--chip-bottom', `calc(${footOf} + ${Math.round(el.offsetHeight)}px)`)
      root.setProperty('--chip-head', footOf)
    }
    publish()
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null
    watch?.observe(el)
    return () => {
      watch?.disconnect()
      root.removeProperty('--chip-bottom')
      root.removeProperty('--chip-head')
    }
  }, [footOf])

  if (!visible) return null

  const glass = dark
    ? 'border-white/10 bg-slate-900/60 text-slate-50 shadow-[0_20px_60px_rgba(0,0,0,0.45)]'
    : 'border-white/70 bg-white/70 text-slate-900 shadow-[0_20px_60px_rgba(15,23,42,0.28)]'
  const muted = dark ? 'text-slate-300/80' : 'text-slate-500'
  const rule = dark ? 'border-white/10' : 'border-slate-900/10'
  const enter = 'transition-[opacity,translate] duration-300 ease-out starting:translate-y-2 starting:opacity-0 motion-reduce:transition-none'

  if (view === 'chip') {
    const pending = !name && !skipped
    const at = layout === 'wide' ? CHIP_AT.wide : chipTop ? CHIP_AT.compact : CHIP_AT.shortTouch
    // While the site's model is got the chip grows a second row for it (its progress and its Stop); its foot, published
    // above, follows.
    const pill = `pointer-events-auto absolute ${at} flex ${getting ? 'flex-col items-stretch rounded-2xl' : 'items-center rounded-full'} border text-[12px] backdrop-blur-xl backdrop-saturate-150 ${glass} ${enter}`
    // shortTouch's other measures read --chip-top, so the walk's top replaces that, not `top`.
    const style: CSSProperties | undefined = chipTop ? { top: chipTop } : walkTop ? ({ '--chip-top': walkTop } as CSSProperties) : undefined
    const strip = getting && (
      <div className={`flex items-center gap-2 border-t py-1 pr-3 pl-2.5 ${rule}`} data-site-strip={getting.step}>
        <span className={`min-w-0 flex-1 truncate tabular-nums ${muted}`}>{stripLine(getting)}</span>
        <span role="progressbar" aria-label={getting.step === 'download' ? `Downloading ${CONCIERGE_NAME}’s model` : `Keeping ${CONCIERGE_NAME}’s model in this page`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(getting)}
          className={`block h-1 w-10 shrink-0 overflow-hidden rounded-full ${dark ? 'bg-white/15' : 'bg-slate-900/10'}`}>
          <span className={`block h-full rounded-full ${dark ? 'bg-white' : 'bg-slate-900'}`} style={{ width: `${percent(getting)}%` }} />
        </span>
        {getting.step === 'download' && <button type="button" onClick={stopGetting} className={`shrink-0 font-medium underline-offset-2 hover:underline ${muted}`} data-action="stop-model">Stop</button>}
      </div>
    )
    const ask = (
      <>
        <SloaneMark size={24} />
        <span className="font-semibold">{SLOANE.name}</span>{' '}
        <span className={`truncate ${muted}`}>{compact ? 'Your name?' : 'What should I call you?'}</span>
      </>
    )
    const buttons = (
      <>
        <button type="button" onClick={openGoal} className="flex min-w-0 items-center gap-2 py-1 pr-2.5 pl-1" data-concierge="chip">
          <SloaneMark size={24} />
          <span className="truncate font-semibold">Tell {SLOANE.name} a goal</span>
        </button>
        <button type="button" onClick={() => open('help')} className={`shrink-0 border-l py-1.5 pr-3.5 pl-2.5 ${rule} ${muted}`} data-concierge="chip-controls">
          Controls
        </button>
        {onLook && (
          <button type="button" onClick={onLook} className={`shrink-0 border-l py-1.5 pr-3.5 pl-2.5 ${rule} ${muted}`} data-concierge="chip-look">
            Look
          </button>
        )}
      </>
    )
    return (
      <div className="ui-zoom pointer-events-none absolute inset-0 z-30 font-sans antialiased select-none">
        {pending && !strip ? (
          <button ref={chipRef} type="button" onClick={askForName} className={`${pill} gap-2 py-1 pr-3.5 pl-1`} style={style} data-concierge="chip">
            {ask}
          </button>
        ) : pending ? (
          <div ref={chipRef} className={pill} style={style} role="group" aria-label={`${SLOANE.name}, your concierge`}>
            <button type="button" onClick={askForName} className="flex min-w-0 items-center gap-2 py-1 pr-3.5 pl-1" data-concierge="chip">
              {ask}
            </button>
            {strip}
          </div>
        ) : (
          <div ref={chipRef} className={pill} style={style} role="group" aria-label={`${SLOANE.name}, your concierge`}>
            {strip ? <div className="flex min-w-0 items-center">{buttons}</div> : buttons}
            {strip}
          </div>
        )}
      </div>
    )
  }

  const tips = view === 'greet' || view === 'help' ? controlHints(family, driving, view === 'help' ? 'all' : 'tips') : []
  const { step, brief } = dialogue
  const phase = view !== 'goal' ? null : brief ? (brief.chat ? 'chat' : 'brief') : step ? 'why' : 'goal'
  const line: ReactNode =
    view === 'ask' ? <>Hi, I’m {SLOANE.name}, your concierge. I’ll get you set up — what should I call you?</>
    : view === 'goal' ? (
      step ? step.question
      : brief ? (brief.chat ? talkLine(talk) : worded?.brief === brief ? worded.text : brief.root)
      : <>What would you like the city to do? The time of day, the crowds, the traffic, how it runs, where to go — say it plainly.</>
    )
    : view === 'help' ? (name ? <>Here’s everything you can do, <bdi>{name}</bdi>.</> : <>Here’s everything you can do.</>)
    : view === 'nudge' ? (nudge?.text ?? '')
    : mood === 'new' ? <>Great to meet you, <bdi className="font-semibold">{name}</bdi>. Your avatar is ready — let’s get you moving.</>
    : mood === 'renamed' ? <>Got it — I’ll call you <bdi className="font-semibold">{name}</bdi> from now on. Your avatar is ready.</>
    : mood === 'back' ? <>Welcome back, <bdi className="font-semibold">{name}</bdi>. Your avatar is ready whenever you are.</>
    : <>No problem — you can tell me later. Here’s how to get around.</>
  const wide = layout === 'wide'
  const at = wide ? 'relative shrink-0' : `absolute ${layout === 'tall' ? (overlay ? CARD_AT.tallTouch : CARD_AT.tall) : !overlay ? CARD_AT.shortRaised : driving ? CARD_AT.shortDriving : CARD_AT.short}`
  const tight = layout === 'short'
  // Desktop: three columns. Phones: the full list in two columns, the three tips as a wrapping row (short).
  const list = layout === 'wide' ? 'grid grid-cols-3 gap-x-4 gap-y-2' : view === 'help' ? 'grid grid-cols-2 gap-x-4 gap-y-2' : 'flex flex-wrap gap-x-4 gap-y-2'
  // A phone in landscape has ~180 px under the centre line: there the ORC Notice waits in the full list
  // (one tap on the chip) instead of lifting the first cards into the centre of view.
  const notice = !tight || view === 'help'
  const gap = tight ? 'mt-2' : 'mt-3'
  const field = dark
    ? 'border-white/15 bg-slate-950/40 text-slate-50 placeholder:text-slate-400 focus:border-white/40'
    : 'border-slate-900/15 bg-white/85 text-slate-900 placeholder:text-slate-400 focus:border-slate-900/40'
  const primary = dark ? 'bg-white text-slate-900' : 'bg-slate-900 text-white'
  const chip = dark ? 'border-white/15 bg-white/10 hover:bg-white/20' : 'border-slate-900/15 bg-white/60 hover:bg-white'
  const link = `text-[12px] font-medium underline-offset-2 hover:underline ${muted}`
  const done = brief ? brief.plan.filter((s) => dialogue.applied.includes(s.control)) : []
  const later = brief ? brief.plan.filter((s) => !dialogue.applied.includes(s.control)) : []

  // A speaker layout: Sloane's mark beside their name and line, everything they offer under the line.
  const card = (
    <aside
      ref={cardRef}
      aria-label={`${SLOANE.name}, your concierge`}
      data-concierge={view}
      data-phase={phase ?? undefined}
      className={`pointer-events-auto ${at} rounded-3xl border backdrop-blur-2xl backdrop-saturate-150 ${glass} ${tight ? 'px-4 py-3' : 'px-5 py-4'} ${enter}`}
    >
      <div className="flex gap-3">
        <SloaneMark size={tight ? 28 : 32} speaking />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 leading-tight">
            <span className="text-[14px] font-semibold tracking-tight">{SLOANE.name}</span>{' '}
            <span className={`truncate text-[11px] ${muted}`}>Concierge · {SLOANE.pronouns}</span>
            {view !== 'ask' && (
              <button
                type="button"
                onClick={settle}
                aria-label="Close"
                className={`-my-1 -mr-2 ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[15px] leading-none ${muted} ${dark ? 'hover:bg-white/10' : 'hover:bg-slate-900/5'}`}
              >
                ×
              </button>
            )}
          </div>
          {talking && brief && (
            <p className={`mt-1 truncate text-[12px] leading-snug ${muted}`} data-you>
              <span className="sr-only">You said: </span>“<bdi>{brief.goal}</bdi>”
            </p>
          )}
          <p aria-live="polite" aria-busy={talking && talk?.state === 'waiting'} className="mt-1 text-[14px] leading-snug">{line}</p>

          {view === 'ask' && (
            <form onSubmit={submit} className={`${gap} flex items-center gap-2`}>
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onInputKey}
                maxLength={NAME_MAX}
                placeholder="Your name"
                aria-label="Your name"
                autoComplete="nickname"
                autoCapitalize="words"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                dir="auto"
                className={`min-w-0 flex-1 rounded-xl border px-3 py-2 outline-none ${compact ? 'text-[16px]' : 'text-[14px]'} ${field}`}
              />
              <button type="submit" className={`shrink-0 rounded-xl px-3.5 py-2 text-[13px] font-semibold ${primary}`}>
                Continue{family === 'keyboard' && <span aria-hidden className="ml-1.5 opacity-60">↵</span>}
              </button>
              <button type="button" onClick={cancelAsk} className={`shrink-0 px-1 py-2 text-[12px] ${muted} hover:underline`}>
                {name ? 'Cancel' : 'Skip'}
              </button>
            </form>
          )}

          {view === 'goal' && !brief && (
            <>
              <div role="group" aria-label={step ? 'Quick replies' : 'Goals to try'} className={`${gap} flex flex-wrap gap-1.5`} data-chips={step ? 'answers' : 'goals'}>
                {(step ? step.options : STARTERS).map((o) => (
                  <button key={o} type="button" onClick={() => reply(o)} className={`rounded-full border px-3 py-1.5 text-[12px] font-medium ${chip}`} data-chip={step ? 'answer' : 'goal'}>
                    {o}
                  </button>
                ))}
              </div>
              <form onSubmit={submitGoal} className="mt-2 flex items-center gap-2">
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onGoalKey}
                  maxLength={GOAL_MAX}
                  placeholder={step ? 'Or say it your own way' : compact ? 'Make it night…' : 'Make it night, or take me to the harbour'}
                  aria-label={step ? 'Your answer' : 'Your goal'}
                  autoComplete="off"
                  autoCapitalize="sentences"
                  spellCheck={false}
                  enterKeyHint="send"
                  dir="auto"
                  className={`min-w-0 flex-1 rounded-xl border px-3 py-2 outline-none ${compact ? 'text-[16px]' : 'text-[14px]'} ${field}`}
                />
                <button type="submit" className={`shrink-0 rounded-xl px-3.5 py-2 text-[13px] font-semibold ${primary}`}>
                  Continue{family === 'keyboard' && <span aria-hidden className="ml-1.5 opacity-60">↵</span>}
                </button>
                <button type="button" onClick={backOut} className={`shrink-0 px-1 py-2 text-[12px] ${muted} hover:underline`}>
                  {step ? 'Back' : 'Cancel'}
                </button>
              </form>
            </>
          )}

          {view === 'goal' && brief?.chat && (
            <div className={gap} data-chat={talk?.state ?? 'none'}>
              {replying && (
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {!talk.text && <span className={`text-[12px] leading-tight ${muted}`}>{starting ? 'Starting the model… the first answer takes longer' : 'Thinking…'}</span>}
                  <button type="button" onClick={stopTalk} className={link} data-action="stop">Stop</button>
                </div>
              )}
              {talk?.state === 'none' && (
                <div data-no-model>
                  {getting ? (
                    <div data-site-model={getting.step}>
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className={`text-[12px] leading-tight tabular-nums ${muted}`}>{gettingLine(getting)}</span>
                        {getting.step === 'download' && <button type="button" onClick={stopGetting} className={link} data-action="stop-model">Stop</button>}
                      </div>
                      <div
                        role="progressbar"
                        aria-label={getting.step === 'download' ? 'Downloading the model' : 'Keeping the model in this page'}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent(getting)}
                        className={`mt-1.5 h-1 overflow-hidden rounded-full ${dark ? 'bg-white/15' : 'bg-slate-900/10'}`}
                      >
                        <div className={`h-full rounded-full ${dark ? 'bg-white' : 'bg-slate-900'}`} style={{ width: `${percent(getting)}%` }} />
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      {site && (
                        <button type="button" onClick={getSite} className={`rounded-xl px-3.5 py-2 text-[13px] font-semibold ${primary}`} data-action="site-model">
                          {site.kept ? 'Use the model kept here' : `Get the model · ${site.size}`}
                        </button>
                      )}
                      {onPickModel && !noPageModel && (
                        <button type="button" onClick={onPickModel} className={site ? link : `rounded-xl px-3.5 py-2 text-[13px] font-semibold ${primary}`} data-action="model-file">
                          Choose a model file
                        </button>
                      )}
                      <button type="button" onClick={askAgain} className={link} data-action="ask-again">Ask again</button>
                    </div>
                  )}
                  {gotWhy && !getting && <p role="status" className={`mt-1.5 text-[11px] leading-snug break-words ${muted}`} data-site-why>{gotWhy}</p>}
                  <p className={`mt-2 text-[12px] leading-snug ${muted}`}>
                    {site ? siteHint(site) : onPickModel && !noPageModel ? `${SMALL_MODEL_HINT} ` : noPageModel ? `This browser can’t run a model inside the page (${noPageModel}). ` : ''}
                    Or start Ollama, LM Studio or a llama.cpp server on this computer and ask again
                    {serverNote(typeof window === 'undefined' ? '' : window.location.origin)}.
                  </p>
                  {talk.why && (
                    <details className={`mt-1 text-[11px] leading-snug ${muted}`}>
                      <summary className="cursor-pointer">Where I looked</summary>
                      <span className="break-words">{talk.why}</span>
                    </details>
                  )}
                </div>
              )}
              {(talk?.state === 'slow' || talk?.state === 'failed' || talk?.state === 'held' || talk?.state === 'stopped') && (
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {talk.state !== 'held' && <button type="button" onClick={askAgain} className={link} data-action="ask-again">Ask again</button>}
                  {talk.why && <span className={`min-w-0 text-[11px] leading-snug break-words ${muted}`}>{talk.why}</span>}
                </div>
              )}
              <form onSubmit={submitGoal} className="mt-2 flex items-center gap-2">
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onGoalKey}
                  maxLength={GOAL_MAX}
                  placeholder={compact ? 'Say something…' : 'Say something, or ask for a change'}
                  aria-label="Your words to Sloane"
                  autoComplete="off"
                  autoCapitalize="sentences"
                  spellCheck={false}
                  enterKeyHint="send"
                  dir="auto"
                  className={`min-w-0 flex-1 rounded-xl border px-3 py-2 outline-none ${compact ? 'text-[16px]' : 'text-[14px]'} ${field}`}
                />
                <button type="submit" disabled={replying} className={`shrink-0 rounded-xl px-3.5 py-2 text-[13px] font-semibold disabled:opacity-50 ${primary}`}>
                  Send{family === 'keyboard' && <span aria-hidden className="ml-1.5 opacity-60">↵</span>}
                </button>
                <button type="button" onClick={backOut} className={`shrink-0 px-1 py-2 text-[12px] ${muted} hover:underline`}>
                  Done
                </button>
              </form>
            </div>
          )}

          {view === 'goal' && brief && !brief.chat && (
            <div className={gap} data-brief>
              {done.length > 0 && <PlanList title="Done" steps={done} ticked dark={dark} />}
              {later.length > 0 && <PlanList title="Plan" steps={later} ticked={false} dark={dark} />}
              {brief.unmapped.length > 0 && (
                <ul className={`${done.length + later.length ? 'mt-2' : ''} flex flex-col gap-1`} data-unmapped>
                  {brief.unmapped.map((u) => (
                    <li key={u} className={`text-[12px] leading-tight ${muted}`}>{u}</li>
                  ))}
                </ul>
              )}
              {lanes && lanes.length > 0 && brief.plan.some((s) => s.control === 'dispatch') && (
                <ul className="mt-2 flex flex-col gap-0.5" data-team aria-label="The team at work">
                  {lanes.slice(0, TEAM_ROWS).map((l) => (
                    <li key={l.tag} className={`flex items-baseline gap-2 text-[12px] leading-tight ${muted}`} data-lane={l.state}>
                      <span className="shrink-0 font-mono text-[11px]">{l.tag}</span>
                      <span className="min-w-0 truncate">{l.state === 'isolated' ? 'isolated by the gate' : l.reading ?? 'reading the city'}</span>
                    </li>
                  ))}
                  {lanes.length > TEAM_ROWS && <li className={`text-[12px] leading-tight ${muted}`}>and {lanes.length - TEAM_ROWS} more</li>}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <button type="button" onClick={copyBrief} className={`rounded-xl px-3.5 py-2 text-[13px] font-semibold ${primary}`} data-action="copy">
                  {copied === 'yes' ? 'Copied' : 'Copy brief'}
                </button>
                {brief.plan.some((s) => s.control === 'controls') && (
                  <button type="button" onClick={() => open('help')} className={link} data-action="controls">Show the controls</button>
                )}
                <button type="button" onClick={openGoal} className={link} data-action="again">Another goal</button>
              </div>
              {copied === 'shown' && (
                <textarea
                  readOnly
                  autoFocus
                  value={brief.markdown}
                  aria-label="The brief, to copy by hand"
                  onFocus={(e) => e.currentTarget.select()}
                  className={`mt-2 h-28 w-full resize-none rounded-xl border px-3 py-2 font-mono text-[11px] leading-snug outline-none ${field}`}
                />
              )}
            </div>
          )}

          {tips.length > 0 && (
            <ul className={`${gap} ${list}`}>
              {tips.map((h) => (
                <li key={h.action} className="flex min-w-0 items-center gap-2">
                  <GlyphKey glyph={h.glyph} kind={h.kind} />{' '}
                  <span className="min-w-0 leading-tight">{h.label}</span>
                </li>
              ))}
            </ul>
          )}

          {view === 'greet' && (
            <button type="button" onClick={openGoal} className={`${gap} block ${link}`} data-action="goal">
              or tell me what you’d like the city to do
            </button>
          )}

          {view === 'nudge' && (
            <div className={`${gap} flex flex-wrap gap-x-4 gap-y-1`}>
              <button type="button" onClick={settle} className={link} data-action="later">
                Got it
              </button>
              <button type="button" onClick={openGoal} className={link} data-action="goal">
                Tell {SLOANE.name} a goal
              </button>
            </div>
          )}

          {view === 'help' && (
            <div className={`${gap} flex flex-wrap gap-x-4 gap-y-1`}>
              <button type="button" onClick={openGoal} className={link} data-action="goal">
                Tell {SLOANE.name} a goal
              </button>
              <button type="button" onClick={askForName} className={link}>
                {name ? 'Change my name' : `Tell ${SLOANE.name} your name`}
              </button>
              {onLook && (
                <button type="button" onClick={onLook} className={link} data-action="look">
                  Change my look
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {getting && !(talking && talk?.state === 'none') && (
        <div className={`${tight ? 'mt-2 pt-2' : 'mt-3 pt-2.5'} flex items-center gap-3 border-t ${rule}`} data-site-strip={getting.step}>
          <span className={`min-w-0 shrink-0 text-[12px] leading-tight tabular-nums ${muted}`}>{gettingLine(getting)}</span>
          <span role="progressbar" aria-label={getting.step === 'download' ? `Downloading ${SLOANE.name}’s model` : `Keeping ${SLOANE.name}’s model in this page`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(getting)}
            className={`block h-1 min-w-8 flex-1 overflow-hidden rounded-full ${dark ? 'bg-white/15' : 'bg-slate-900/10'}`}>
            <span className={`block h-full rounded-full ${dark ? 'bg-white' : 'bg-slate-900'}`} style={{ width: `${percent(getting)}%` }} />
          </span>
          {getting.step === 'download' && <button type="button" onClick={stopGetting} className={link} data-action="stop-model">Stop</button>}
        </div>
      )}

      {notice && (
        <p className={`${tight ? 'mt-2 pt-2' : 'mt-3.5 pt-2.5'} border-t text-[10px] leading-snug ${rule} ${muted}`} data-notice="orc">
          {ORC_AFTER === undefined ? ORC_NOTICE : <>{ORC_BEFORE}<span className="whitespace-nowrap">{ORC_REGISTRATION}</span>{ORC_AFTER}</>}
        </p>
      )}
    </aside>
  )
  return (
    <div className="ui-zoom pointer-events-none absolute inset-0 z-30 font-sans text-[13px] antialiased">
      {wide ? <div className={beside && roomy ? WIDE_BESIDE : WIDE_COLUMN}>{card}<div aria-hidden className={WIDE_SPACER} /></div> : card}
    </div>
  )
}

/** The brief's steps as the card shows them: ticked once the host has applied them, otherwise the plan.
 *  Labels only — the module paths stay in the copyable brief. */
function PlanList({ title, steps, ticked, dark }: { title: string; steps: readonly PlanStep[]; ticked: boolean; dark: boolean }) {
  const muted = dark ? 'text-slate-300/80' : 'text-slate-500'
  const mark = ticked
    ? dark ? 'bg-white text-slate-900' : 'bg-slate-900 text-white'
    : `border ${dark ? 'border-white/30' : 'border-slate-900/30'}`
  return (
    <div className="mt-2 first:mt-0" data-plan={ticked ? 'done' : 'later'}>
      <div className={`text-[10px] font-semibold tracking-wider uppercase ${muted}`}>{title}</div>
      <ul className="mt-1 flex flex-col gap-1">
        {steps.map((s) => (
          <li key={s.control} className="flex items-start gap-2 leading-tight" data-step={s.control}>
            <span aria-hidden className={`mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${mark}`}>
              {ticked ? '✓' : ''}
            </span>
            <span className="sr-only">{ticked ? 'Done: ' : 'To do: '}</span>
            <span className="min-w-0">{s.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Beside the local-server hint: a page not served from this computer is answered by Ollama only once its origin is allowed. */
/** No site's model: nothing to subscribe to, and no job (useSyncExternalStore's stand-ins, the same functions every render). */
const NO_SUBSCRIBE = (): (() => void) => () => undefined
const NO_JOB = (): SiteJobState | null => null

/** The strip's short line, where the conversation does not show the full one: the chip and the card's other views. */
function stripLine(p: SiteModelProgress): string {
  return p.step === 'download' ? `${CONCIERGE_NAME}’s model · ${percent(p)}%` : `Keeping ${CONCIERGE_NAME}’s model · ${percent(p)}%`
}

/** How far getting the site's model has come, as a whole percent. */
function percent(p: SiteModelProgress): number {
  return p.total > 0 ? Math.min(100, Math.max(0, Math.floor((p.done / p.total) * 100))) : 0
}

/**
 * The line over the bar while the site's model is got: megabytes while it downloads (kilobytes for a file under one
 * megabyte, so a small one never reads "0 of 0 MB"), a percent while it is kept.
 */
function gettingLine(p: SiteModelProgress): string {
  if (p.step === 'keep') return `Keeping it in this page · ${percent(p)}%`
  if (p.total <= 0) return 'Downloading…'
  const [unit, name] = p.total >= 1024 ** 2 ? [1024 ** 2, 'MB'] : [1024, 'KB']
  return `Downloading · ${Math.floor(p.done / unit)} of ${Math.round(p.total / unit)} ${name}`
}

/** The hint under the site's model: what it is, where it comes from, and where it stays. */
function siteHint(site: SiteModelLine): string {
  return site.kept
    ? `${site.title} is kept in this browser already. `
    : `${site.title}, ${site.size}: downloaded once from this site, checked against the copy this page was built for, and kept in this browser (Apache-2.0). `
}

function serverNote(origin: string): string {
  if (!/^https?:/.test(origin) || LOOPBACK_PAGE.test(origin)) return ''
  return ` (Ollama answers this page only with ${origin} in OLLAMA_ORIGINS)`
}

/** The card's line in plain words (the JSX above, without its markup), or '' for a view with nothing to say aloud. */
function spokenLine(view: View, mood: Mood, name: string, nudge: Nudge | null, dialogue: Pick<Dialogue, 'step' | 'brief'>): string {
  switch (view) {
    case 'ask': return `Hi, I’m ${SLOANE.name}, your concierge. I’ll get you set up. What should I call you?`
    case 'goal': return dialogue.step ? dialogue.step.question : dialogue.brief ? dialogue.brief.root : 'What would you like the city to do? Say it plainly.'
    case 'nudge': return nudge?.text ?? ''
    case 'greet':
      return mood === 'new' ? `Great to meet you, ${name}. Your avatar is ready. Let’s get you moving.`
        : mood === 'renamed' ? `Got it. I’ll call you ${name} from now on. Your avatar is ready.`
        : mood === 'back' ? `Welcome back, ${name}. Your avatar is ready whenever you are.`
        : 'No problem. You can tell me later. Here’s how to get around.'
    default: return ''
  }
}

/** Sloane's mark: a dark disc with their initial and a warm ring (brighter while they are talking). */
function SloaneMark({ size, speaking = false }: { size: number; speaking?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-[radial-gradient(circle_at_32%_28%,#475569,#0f172a_62%,#020617)] font-semibold tracking-tight text-white ring-2 ${speaking ? 'ring-amber-300/80' : 'ring-amber-300/45'}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }}
    >
      S
    </span>
  )
}
