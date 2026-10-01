/**
 * Why does this file exist? It is the spatial HUD's Concierge: Wren (they/them), an original character
 * who meets the player as the boot veil lifts. On a first visit Wren asks what to call them — with a
 * keyboard the name field is already focused, so they just type and press Enter (zero clicks) — saves
 * the profile that seeds their avatar, and answers by name with three glyph-aware tips. A returning
 * player is welcomed back by name. Either way Wren then offers to take a goal: a plain-language wish
 * ("make it night", "it feels laggy") that the deterministic 5-Whys engine in intent.ts refines through a
 * few questions with quick-reply chips and a text field, then shows as a brief — the steps the host
 * applied ticked, the rest as a plan — with a copyable architecture brief for an engineer. The card then
 * settles into a small chip that offers the goal dialogue and reopens the full control list. The ORC
 * Notice is the card's fine print (on a phone held in landscape, only in the full list).
 * What breaks if it is removed? Nobody is greeted, the avatar never gets a name or seed, first-time
 * players get no controls help, a goal has nowhere to go, and the ORC Notice is no longer shown in the
 * running product.
 *
 * Only the card and the chip take pointer events. Placement never covers the centre of view: desktop,
 * below the centre and above the HUD's bottom-centre prompts; phone upright, the band under the header and
 * minimap (clear of the on-screen keyboard); phone in landscape, bottom-centre between the thumbs.
 */
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { ORC_NOTICE } from '../02_Define_The_Rules/degrees.ts'
import { NAME_MAX, saveProfile, sanitizeName, seedFromName, type Profile } from '../05_Observe_Environment/profile.ts'
import { FiveWhys, GOAL_MAX, type Brief, type Control, type PlanStep, type WhyStep } from '../06_Make_Decisions/intent.ts'
import { controlHints, isPadFamily, type GlyphFamily } from './glyphs.ts'
import { GlyphKey } from './Hud.tsx'

/** The Concierge's name, for any other surface that mentions them. */
export const CONCIERGE_NAME = 'Wren'

const WREN = {
  name: CONCIERGE_NAME,
  pronouns: 'they/them',
  /** How long a greeting stays open before settling into the chip (and how long a controller player,
   *  who cannot type, sees the name question). */
  settleMs: 8000,
  /** Ground covered, from any input, that counts as the first movement and puts an open card away. */
  settleMetres: 1,
} as const

type View = 'ask' | 'greet' | 'help' | 'chip' | 'goal'
type Mood = 'new' | 'back' | 'renamed' | 'skipped'

/** Keys that mean the player is under way: the open card steps aside. */
const MOVE_KEYS: ReadonlySet<string> = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyE'])

/** Goals offered as chips before the player types one: plain phrases the engine maps. */
const STARTERS = ['Make it night', 'Golden hour', 'Smoother', 'Fewer people', 'Show me around'] as const

/** The goal dialogue: no goal yet, a question on screen, or (questions over) the brief. `applied` are
 *  the immediate steps the host carried out, ticked in the card and the copyable brief. */
interface Dialogue { whys: FiveWhys | null; step: WhyStep | null; brief: Brief | null; applied: readonly Control[] }
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
 *  7 rem top-right with the speed chip (≈ 3.6 rem) under it while driving; touch stick zone and buttons
 *  ≈ 12.5 rem square in the bottom corners.
 *  Desktop: a column from just below the centre of view down to the HUD frame. The card stands at its foot
 *  on a spacer that clears the bottom-centre prompts; in a short window the spacer gives way first (down to
 *  the capture hint, which has its key row only under the HUD's ROOMY query, repeated here), so the card
 *  stays below the centre unless it is taller than the whole column. */
const WIDE_COLUMN = 'absolute top-[calc(50%+1rem)] bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-1/2 flex w-[min(38rem,max(22rem,calc(100%_-_30.5rem)))] -translate-x-1/2 flex-col justify-end'
const WIDE_SPACER = 'h-[8.5rem] min-h-[3.25rem] shrink [@media(min-width:1100px)_and_(min-height:600px)]:min-h-[5rem]'
const CARD_AT = {
  tall: 'top-[calc(max(0.75rem,env(safe-area-inset-top))+8.75rem)] right-[max(0.75rem,env(safe-area-inset-right))] left-[max(0.75rem,env(safe-area-inset-left))] mx-auto max-w-[28rem]',
  short: 'bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-1/2 w-[min(28rem,calc(100%_-_26rem))] min-w-[18rem] -translate-x-1/2',
  shortRaised: 'bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+4.5rem)] left-1/2 w-[min(28rem,calc(100%_-_26rem))] min-w-[18rem] -translate-x-1/2',
} as const
const CHIP_AT = {
  wide: 'bottom-[calc(max(1.25rem,env(safe-area-inset-bottom))+13.75rem)] left-[max(1.25rem,env(safe-area-inset-left))]',
  compact: 'top-[calc(max(0.75rem,env(safe-area-inset-top))+7.5rem)] right-[max(0.75rem,env(safe-area-inset-right))]',
  compactDriving: 'top-[calc(max(0.75rem,env(safe-area-inset-top))+11.75rem)] right-[max(0.75rem,env(safe-area-inset-right))]',
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
}

export function Concierge({ visible, profile, onProfile, family, driving, dark = false, settleMs = WREN.settleMs, travelled, onIntent, goal, onLook }: ConciergeProps) {
  const small = useSyncExternalStore(SMALL.subscribe, SMALL.matches, SMALL.server)
  const short = useSyncExternalStore(SHORT.subscribe, SHORT.matches, SHORT.server)
  const [view, setView] = useState<View>(() => (goal ? 'goal' : profile ? 'greet' : 'ask'))
  const [mood, setMood] = useState<Mood>(() => (profile ? 'back' : 'new'))
  /** The name given this session: the parent's `profile` may lag it by a render. */
  const [given, setGiven] = useState('')
  const [skipped, setSkipped] = useState(false)
  /** The one text field: the name, then a goal, then each answer. */
  const [draft, setDraft] = useState('')
  const [dialogue, setDialogue] = useState<Dialogue>(() => resume(goal))
  /** The brief on the clipboard, or shown to copy by hand where the clipboard is out of reach. */
  const [copied, setCopied] = useState<'no' | 'yes' | 'shown'>('no')
  /** Bumped whenever a card opens or a question changes: restarts the settle timer and the focus effect. */
  const [epoch, setEpoch] = useState(0)
  const cardRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** The next ask or goal card takes focus even on touch (the player tapped for it, so a keyboard may rise). */
  const focusNext = useRef(false)
  // Previous props, for adjusting state while rendering (React's pattern for reacting to a prop change).
  const [seenProfile, setSeenProfile] = useState(profile)
  const [seenDriving, setSeenDriving] = useState(driving)

  const name = given || profile?.name || ''
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
    setDialogue({ whys, step, brief: step ? null : whys.brief(done), applied: done })
    setCopied('no')
    setDraft('')
    // On touch the chips are the way to answer: let the on-screen keyboard drop between questions.
    if (family === 'touch') inputRef.current?.blur()
    setEpoch((n) => n + 1)
  }
  const startGoal = (text: string) => {
    const goalText = text.trim()
    if (goalText) advance(new FiveWhys(goalText), [])
  }
  const reply = (text: string) => {
    if (dialogue.whys && dialogue.step) {
      dialogue.whys.answer(text)
      advance(dialogue.whys, dialogue.applied)
    } else startGoal(text)
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
    setDraft('')
    setDialogue(NO_GOAL)
    setCopied('no')
    open('goal')
  }
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

  // Greetings settle into the chip; so does the name question for a controller player, who may have no
  // keyboard — unless they have started typing (typing into the field leaves the family unchanged).
  const padAsk = view === 'ask' && isPadFamily(family) && draft === ''
  useEffect(() => {
    if (!visible || (view !== 'greet' && !padAsk)) return
    const id = window.setTimeout(() => setView('chip'), settleMs)
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
    else if (travelled - travelFrom.current >= WREN.settleMetres) setView('chip')
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
  const fielded = view === 'ask' || (view === 'goal' && dialogue.brief === null)
  useEffect(() => {
    if (visible && fielded) focusField()
  }, [visible, fielded, epoch])

  if (!visible) return null

  const compact = small || family === 'touch'
  const layout = !compact ? 'wide' : short ? 'short' : 'tall'
  const glass = dark
    ? 'border-white/10 bg-slate-900/60 text-slate-50 shadow-[0_20px_60px_rgba(0,0,0,0.45)]'
    : 'border-white/70 bg-white/70 text-slate-900 shadow-[0_20px_60px_rgba(15,23,42,0.28)]'
  const muted = dark ? 'text-slate-300/80' : 'text-slate-500'
  const rule = dark ? 'border-white/10' : 'border-slate-900/10'
  const enter = 'transition-[opacity,translate] duration-300 ease-out starting:translate-y-2 starting:opacity-0 motion-reduce:transition-none'

  if (view === 'chip') {
    const pending = !name && !skipped
    const at = layout === 'wide' ? CHIP_AT.wide : driving && layout === 'tall' ? CHIP_AT.compactDriving : CHIP_AT.compact
    const pill = `pointer-events-auto absolute ${at} flex max-w-[18rem] items-center rounded-full border text-[12px] backdrop-blur-xl backdrop-saturate-150 ${glass} ${enter}`
    return (
      <div className="pointer-events-none absolute inset-0 z-30 font-sans antialiased select-none">
        {pending ? (
          <button type="button" onClick={askForName} className={`${pill} gap-2 py-1 pr-3.5 pl-1`} data-concierge="chip">
            <WrenMark size={24} />
            <span className="font-semibold">{WREN.name}</span>{' '}
            <span className={`truncate ${muted}`}>{compact ? 'Your name?' : 'What should I call you?'}</span>
          </button>
        ) : (
          <div className={pill} role="group" aria-label={`${WREN.name}, your concierge`}>
            <button type="button" onClick={openGoal} className="flex min-w-0 items-center gap-2 py-1 pr-2.5 pl-1" data-concierge="chip">
              <WrenMark size={24} />
              <span className="truncate font-semibold">Tell {WREN.name} a goal</span>
            </button>
            <button type="button" onClick={() => open('help')} className={`shrink-0 border-l py-1.5 pr-3.5 pl-2.5 ${rule} ${muted}`} data-concierge="chip-controls">
              Controls
            </button>
            {onLook && (
              <button type="button" onClick={onLook} className={`shrink-0 border-l py-1.5 pr-3.5 pl-2.5 ${rule} ${muted}`} data-concierge="chip-look">
                Look
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const tips = view === 'greet' || view === 'help' ? controlHints(family, driving, view === 'help' ? 'all' : 'tips') : []
  const { step, brief } = dialogue
  const phase = view !== 'goal' ? null : brief ? 'brief' : step ? 'why' : 'goal'
  const line: ReactNode =
    view === 'ask' ? <>Hi, I’m {WREN.name}, your concierge. I’ll get you set up — what should I call you?</>
    : view === 'goal' ? (
      step ? step.question
      : brief ? brief.root
      : <>What would you like the city to do? The time of day, the crowds, the traffic, how it runs, where to go — say it plainly.</>
    )
    : view === 'help' ? (name ? <>Here’s everything you can do, <bdi>{name}</bdi>.</> : <>Here’s everything you can do.</>)
    : mood === 'new' ? <>Great to meet you, <bdi className="font-semibold">{name}</bdi>. Your avatar is ready — let’s get you moving.</>
    : mood === 'renamed' ? <>Got it — I’ll call you <bdi className="font-semibold">{name}</bdi> from now on. Your avatar is ready.</>
    : mood === 'back' ? <>Welcome back, <bdi className="font-semibold">{name}</bdi>. Your avatar is ready whenever you are.</>
    : <>No problem — you can tell me later. Here’s how to get around.</>
  const wide = layout === 'wide'
  const at = wide ? 'relative shrink-0' : `absolute ${layout === 'tall' ? CARD_AT.tall : driving || family !== 'touch' ? CARD_AT.shortRaised : CARD_AT.short}`
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

  // A speaker layout: Wren's mark beside their name and line, everything they offer under the line.
  const card = (
    <aside
      ref={cardRef}
      aria-label={`${WREN.name}, your concierge`}
      data-concierge={view}
      data-phase={phase ?? undefined}
      className={`pointer-events-auto ${at} rounded-3xl border backdrop-blur-2xl backdrop-saturate-150 ${glass} ${tight ? 'px-4 py-3' : 'px-5 py-4'} ${enter}`}
    >
      <div className="flex gap-3">
        <WrenMark size={tight ? 28 : 32} speaking />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 leading-tight">
            <span className="text-[14px] font-semibold tracking-tight">{WREN.name}</span>{' '}
            <span className={`truncate text-[11px] ${muted}`}>Concierge · {WREN.pronouns}</span>
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
          <p aria-live="polite" className="mt-1 text-[14px] leading-snug">{line}</p>

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

          {view === 'goal' && brief && (
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

          {view === 'help' && (
            <div className={`${gap} flex flex-wrap gap-x-4 gap-y-1`}>
              <button type="button" onClick={openGoal} className={link} data-action="goal">
                Tell {WREN.name} a goal
              </button>
              <button type="button" onClick={askForName} className={link}>
                {name ? 'Change my name' : `Tell ${WREN.name} your name`}
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

      {notice && (
        <p className={`${tight ? 'mt-2 pt-2' : 'mt-3.5 pt-2.5'} border-t text-[10px] leading-snug ${rule} ${muted}`} data-notice="orc">
          {ORC_AFTER === undefined ? ORC_NOTICE : <>{ORC_BEFORE}<span className="whitespace-nowrap">{ORC_REGISTRATION}</span>{ORC_AFTER}</>}
        </p>
      )}
    </aside>
  )
  return (
    <div className="pointer-events-none absolute inset-0 z-30 font-sans text-[13px] antialiased">
      {wide ? <div className={WIDE_COLUMN}>{card}<div aria-hidden className={WIDE_SPACER} /></div> : card}
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

/** Wren's mark: a dark disc with their initial and a warm ring (brighter while they are talking). */
function WrenMark({ size, speaking = false }: { size: number; speaking?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-[radial-gradient(circle_at_32%_28%,#475569,#0f172a_62%,#020617)] font-semibold tracking-tight text-white ring-2 ${speaking ? 'ring-amber-300/80' : 'ring-amber-300/45'}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }}
    >
      W
    </span>
  )
}
