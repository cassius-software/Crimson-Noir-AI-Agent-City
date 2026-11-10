// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the card on a home's doorstep: B, E or the HUD's chip inside one of the seven homes
 * (01_Initialize_World/properties.ts) opens it, and it shows that home's deed (storeCatalog.ts, line 224 + the home's
 * index). It gives the home's name and the address the host supplies, a line about the home, its level and its price,
 * and then Buy, or Claim (free) for the free loft, through the one shopkeeper (shopkeeper.ts), so the doorstep and
 * Lintel & Lumen's card can never disagree about what is owned or what it cost. When the gate refuses, the card shows
 * its reason instead; an owner sees "Yours". The purse line says whose credits these are, as the store card's does.
 * The Penthouse and the Sky-Mansion are sold for now as the residences at the foot of their towers, and the card says
 * that the sky floor opens later.
 *
 * Esc, B, the close button or Done puts it away through the host. The listener runs in the capture phase, as the
 * store card's does, and takes only the keys it handles, never H (the HUD's) nor ` (the console's, whose opening puts
 * the card away). A pad's south face button presses the focused button and its d-pad moves focus (padNav.ts), and
 * every button is at least 48 px for a finger.
 * What breaks if it is removed? A home's deed can be bought only at the design house, the free loft cannot be claimed
 * where it stands, and a visitor walking into a home has nothing to tell them what it is or what it costs.
 */
import { useEffect, useRef, useState } from 'react'
import { SHOP_INFO } from '../01_Initialize_World/storefronts.ts'
import { isEditableTarget } from '../04_Connect_Hardware/input.ts'
import { usePadNav } from './padNav.ts'
import type { Shopkeeper } from './shopkeeper.ts'
import { GATE, credits, itemById } from './storeCatalog.ts'

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
  onClose: () => void
}

/** Home `h`'s deed is catalogue line DEED + h, and its property bit is h (storeCatalog.ts). */
const DEED = 224

/**
 * A line about each home, by property index. They speak of the home itself and never of where it stands, because a
 * region places the seven on whatever lots its window offers, and the address line already says where. Every line is
 * invented and passes the 14A screen (homeCard.test.ts reads them from this file).
 */
const HOME_LINES: readonly string[] = Object.freeze([
  'One bright room that costs nothing to claim: the first home any operator can call their own.',
  'Brick walls and old-city manners: the classic first step up from a single room.',
  'Warm timber and wide glass, with room to host friends on long evenings.',
  'A polished residence for an operator on the rise, with a tower\'s name on the deed.',
  'Glass on every side and space to spare, for an operator who likes the light.',
  'A deep, quiet house with space enough to host the whole team.',
  'The grandest home in the city, kept for an operator at the very top of the ladder.',
])

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
    buy: dark ? 'bg-teal-300 text-slate-950 hover:bg-teal-200' : 'bg-teal-700 text-white hover:bg-teal-800',
    off: dark ? 'border-white/10 text-slate-400' : 'border-slate-900/10 text-slate-400',
    yours: dark ? 'border-amber-300/60 text-amber-200' : 'border-amber-700/50 text-amber-800',
    primary: dark ? 'bg-white text-slate-900' : 'bg-slate-900 text-white',
  }
}

/** A button a finger, a mouse and a pad's focus can all use: 48 px tall, with a visible focus ring. */
const BUTTON = 'min-h-12 rounded-full text-[13px] outline-none focus-visible:ring-4 focus-visible:ring-teal-400/60'

export function HomeCard({ visible, home, keeper, homeInfo, dark = false, pad = true, padFrom, onClose }: HomeCardProps) {
  const cardRef = useRef<HTMLElement>(null)
  // The shopkeeper's every change (a purchase here or at the design house, a reset from the console) redraws the card.
  const [, setVersion] = useState(0)
  useEffect(() => keeper.onChange(() => setVersion((v) => v + 1)), [keeper])
  // What the last press did, said once (a live region), at the home it was said at (another home's card starts quiet).
  const [said, setSaid] = useState<{ home: number | null; text: string }>({ home: null, text: '' })
  const item = home !== null ? itemById(DEED + home) : null
  const open = visible && item !== null && item.kind === 'deed'
  usePadNav(cardRef, open && pad, padFrom)

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

  if (!open || home === null || !item) return null
  const t = themeOf(dark)
  const glass = dark
    ? 'border-white/10 bg-slate-900/70 text-slate-50 shadow-[0_20px_60px_rgba(0,0,0,0.45)]'
    : 'border-white/70 bg-white/80 text-slate-900 shadow-[0_20px_60px_rgba(15,23,42,0.28)]'
  const name = homeInfo?.name ?? item.name
  const address = homeInfo?.address ?? ''
  const row = keeper.rows(item.shop, null).find((r) => r.item.id === item.id)
  const verdict = row?.verdict ?? GATE.unavailable
  const owned = row?.owned === true
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
        aria-label={name}
        data-home={home}
        data-verdict={verdict}
        data-owned={owned || undefined}
        className={`pointer-events-auto flex max-h-[min(42rem,100%)] w-[min(26rem,100%)] flex-col rounded-3xl border backdrop-blur-2xl backdrop-saturate-150 ${glass} outline-none`}
      >
        <div className="flex items-start gap-3 px-5 pt-4">
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold leading-tight">{name}</div>
            {address && <div className={`text-[11px] uppercase tracking-wide ${t.muted}`} data-place>{address}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={`${BUTTON} min-w-12 shrink-0 border ${t.pill}`} data-touch>×</button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
          <p className="mt-2 leading-snug" data-tagline>{HOME_LINES[home]}</p>
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

          <div className={`mt-2 flex items-baseline justify-between gap-2 rounded-2xl border px-3 py-2 ${t.rule}`} data-purse>
            <span className="font-semibold">Level {w.level()} · {credits(w.credits())}</span>
            <span className={`text-[11px] ${t.muted}`}>Your civic credits</span>
          </div>
          {!owned && <p className={`mt-2 text-[11px] leading-snug ${t.muted}`} data-also>Also sold at {SHOP_INFO.designHouse.name}</p>}
        </div>

        <p className={`min-h-[1.25rem] px-5 text-[12px] ${t.muted}`} role="status" aria-live="polite" data-said>{said.home === home ? said.text : ''}</p>
        <div className={`flex items-center justify-between gap-2 border-t px-5 py-3 ${t.rule}`}>
          <span className={`text-[11px] ${t.muted}`}>Esc or B closes</span>
          <button type="button" onClick={onClose} className={`${BUTTON} px-5 font-semibold ${t.primary}`} data-action="done" data-touch>Done</button>
        </div>
      </aside>
    </div>
  )
}
