// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is a storefront's card: the shop the avatar stands in (01_Initialize_World/storefronts.ts),
 * its catalogue (storeCatalog.ts) by section, and for every line its level, its price and whether it may be bought now
 * or why not, as the shopkeeper (shopkeeper.ts) answers. A line the body can wear has Try on (worn at once on the
 * player's body, which the mirror camera circles, and taken off again when the card closes unless it was bought),
 * Buy (the shopkeeper's gate takes the credits and sets the owned bit; a bought line is worn at once) and, once owned,
 * Wear. A home's deed sells the same way, and its row also says where the home stands and has Visit (Go home once
 * owned), which the host answers by taking the avatar to the home's doorstep or by saying why it cannot; a deed that
 * would leave less than the cheapest piece of furniture says so before it is bought. A piece of furniture sells the
 * same way and, once owned, says it is placed at home (B in a home one owns opens the home card's furnishing view).
 * Lines the wardrobe does not have yet are listed as on order, with no button. The purse line shows the operator's
 * level and civic credits from the progression keeper. Esc, the close button or Done puts it
 * away; the host gives the eye back to the head.
 * What breaks if it is removed? A shop is a room with nothing to buy in it, and nothing shows what the shops sell.
 */
import { useEffect, useRef, useState } from 'react'
import { SHOP_INFO, type Shop } from '../01_Initialize_World/storefronts.ts'
import type { Look } from '../03_Spawn_Agents/look.ts'
import { GATE, cheapestOnSale, credits, wearItem, type StoreItem } from './storeCatalog.ts'
import type { ShopRow, Shopkeeper } from './shopkeeper.ts'

export interface StoreCardProps {
  /** Show the card (the host passes false while the veil covers the page, the console is open or the city is halted). */
  visible: boolean
  /** The shop whose catalogue it shows, or null. */
  shop: Shop | null
  /** The one shopkeeper the page buys through. */
  keeper: Shopkeeper
  /** The look the player wears (bought and chosen), never a try-on. */
  look: Look
  /** The line being tried on, or null. */
  trying: number | null
  /** Whether the mirror camera circles the body (not in a network room, nor under a headset). */
  mirror?: boolean
  /** Try line `id` on (the host wears `look` on the body without keeping it), or null to take it off. */
  onTry: (id: number | null, look: Look | null) => void
  /** Wear and keep `look` (a bought line; the host saves it like the wardrobe's). */
  onWear: (look: Look) => void
  /** Take the avatar to deed `item`'s home (Visit, or Go home once owned); the host says why when it cannot. */
  onGo?: (item: StoreItem) => void
  /**
   * Where deed `item`'s home stands, as the host knows it: `line` is the address and the compass from here, and `why`
   * is the reason Visit cannot go there now (in a shared room, or the home is not in this map), else null. Null when
   * the host has nothing to say, and then Visit stays off.
   */
  whereFor?: (item: StoreItem) => Where | null
  onClose: () => void
  dark?: boolean
}

/** Where a home stands, and why Visit cannot go there now (null when it can). */
type Where = { line: string; why: string | null }

/** The card's glass, by daylight: the wardrobe card's (Customizer.tsx), with the shops' teal for what may be bought. */
function themeOf(dark: boolean) {
  return {
    muted: dark ? 'text-slate-300/80' : 'text-slate-500',
    rule: dark ? 'border-white/10' : 'border-slate-900/10',
    pill: dark ? 'border-white/15 bg-white/10 hover:bg-white/20' : 'border-slate-900/15 bg-white/60 hover:bg-white',
    pillOn: dark ? 'border-white bg-white text-slate-900' : 'border-slate-900 bg-slate-900 text-white',
    buy: dark ? 'bg-teal-300 text-slate-950 hover:bg-teal-200' : 'bg-teal-700 text-white hover:bg-teal-800',
    off: dark ? 'border-white/10 text-slate-400' : 'border-slate-900/10 text-slate-400',
    primary: dark ? 'bg-white text-slate-900' : 'bg-slate-900 text-white',
    warn: dark ? 'text-amber-200' : 'text-amber-800',
  }
}
type Theme = ReturnType<typeof themeOf>

/** The rows by section, in catalogue order. */
function sections(rows: readonly ShopRow[]): [string, ShopRow[]][] {
  const out = new Map<string, ShopRow[]>()
  for (const r of rows) {
    const list = out.get(r.item.group)
    if (list) list.push(r)
    else out.set(r.item.group, [r])
  }
  return [...out]
}

/**
 * What a deed that may be bought now would leave, when that is less than the cheapest piece of furniture on sale (so
 * the new home could not be furnished at once), in words; else null. A free deed spends nothing and never warns.
 */
function leavesTooLittle(item: StoreItem, verdict: number, balance: number): string | null {
  const cheapest = cheapestOnSale('furniture')
  if (item.kind !== 'deed' || verdict !== GATE.bought || item.price === 0 || cheapest === null) return null
  const left = balance - item.price
  return left < cheapest ? `Leaves ${credits(left)}, less than any furniture` : null
}

function Row({ row, look, trying, t, where, balance, onTry, onBuy, onWear, onGo }: {
  row: ShopRow; look: Look; trying: boolean; t: Theme; where: Where | null; balance: number
  onTry: (item: StoreItem) => void; onBuy: (item: StoreItem) => void; onWear: (item: StoreItem) => void; onGo?: (item: StoreItem) => void
}) {
  const { item, verdict, why, owned, worn } = row
  const fits = wearItem(look, item) !== null
  const status = owned ? (worn ? 'Wearing' : 'Owned') : verdict === GATE.bought ? credits(item.price) : why
  // A deed's row says where its home stands, and why Visit cannot go there now, in words a touch screen shows too.
  const place = where ? [where.line, where.why].filter(Boolean).join(' · ') : ''
  const goOff = where === null || where.why !== null
  const warn = leavesTooLittle(item, verdict, balance)
  return (
    <li className={`flex flex-wrap items-center gap-x-2 gap-y-1 border-b py-2 last:border-b-0 ${t.rule}`} data-item={item.id} data-verdict={verdict} data-owned={owned || undefined} data-worn={worn || undefined}>
      <div className="min-w-0 flex-1">
        <div className="font-medium leading-tight">{item.name}</div>
        <div className={`text-[11px] leading-snug ${t.muted}`}>
          Level {item.level} · {credits(item.price)}{status !== credits(item.price) && <> · <span data-why>{status}</span></>}
        </div>
        {place && <div className={`text-[11px] leading-snug ${t.muted}`} data-place>{place}</div>}
        {warn && <div className={`text-[11px] leading-snug ${t.warn}`} data-warn>{warn}</div>}
        {owned && item.kind === 'furniture' && <div className={`text-[11px] leading-snug ${t.muted}`} data-at-home>Place it at home (B)</div>}
      </div>
      {!owned && fits && (
        <button type="button" onClick={() => onTry(item)} aria-pressed={trying} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${trying ? t.pillOn : t.pill}`} data-action="try">
          {trying ? 'Trying on' : 'Try on'}
        </button>
      )}
      {!owned && (
        <button
          type="button"
          onClick={() => onBuy(item)}
          disabled={verdict !== GATE.bought}
          className={`rounded-full px-3 py-0.5 text-[12px] font-semibold ${verdict === GATE.bought ? t.buy : `border ${t.off} cursor-not-allowed`}`}
          data-action="buy"
        >
          Buy
        </button>
      )}
      {owned && fits && !worn && (
        <button type="button" onClick={() => onWear(item)} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${t.pill}`} data-action="wear">Wear</button>
      )}
      {item.kind === 'deed' && onGo && (
        <button
          type="button"
          onClick={() => onGo(item)}
          disabled={goOff}
          title={where?.why ?? undefined}
          className={`rounded-full border px-2.5 py-0.5 text-[12px] ${goOff ? `${t.off} cursor-not-allowed` : t.pill}`}
          data-action="go"
        >
          {owned ? 'Go home' : 'Visit'}
        </button>
      )}
    </li>
  )
}

export function StoreCard({ visible, shop, keeper, look, trying, mirror = true, onTry, onWear, onGo, whereFor, onClose, dark = false }: StoreCardProps) {
  const cardRef = useRef<HTMLElement>(null)
  // The shopkeeper's every change (a purchase, a reset from the console) redraws the card.
  const [, setVersion] = useState(0)
  useEffect(() => keeper.onChange(() => setVersion((v) => v + 1)), [keeper])
  // What the last press did, said once (a live region), in the shop it was said in (another shop's card starts quiet).
  const [said, setSaid] = useState<{ shop: Shop | null; text: string }>({ shop: null, text: '' })

  // Esc puts the card away (captured, so the game's own key handling never sees it while the card has the keyboard).
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    cardRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, onClose])

  if (!visible || !shop) return null
  const t = themeOf(dark)
  const glass = dark
    ? 'border-white/10 bg-slate-900/70 text-slate-50 shadow-[0_20px_60px_rgba(0,0,0,0.45)]'
    : 'border-white/70 bg-white/80 text-slate-900 shadow-[0_20px_60px_rgba(15,23,42,0.28)]'
  const info = SHOP_INFO[shop.kind]
  const rows = keeper.rows(shop.kind, look)
  const selling = rows.filter((r) => r.verdict !== GATE.unavailable)
  const later = rows.filter((r) => r.verdict === GATE.unavailable)
  const w = keeper.purse

  const tryOn = (item: StoreItem) => {
    if (trying === item.id) { onTry(null, null); return }
    const next = wearItem(look, item)
    if (next) onTry(item.id, next)
  }
  const whereOf = (item: StoreItem): Where | null => (item.kind === 'deed' && whereFor?.(item)) || null
  const buy = (item: StoreItem) => {
    const r = keeper.buy(item.id)
    if (r.verdict === GATE.bought && item.kind === 'deed') {
      // A home bought says where it stands, so the next press can be Go home; a deed is never worn.
      const line = whereOf(item)?.line
      setSaid({ shop, text: line ? `${item.name} is yours: ${line}` : `${item.name} is yours` })
      return
    }
    // A piece of furniture bought is placed at home: B in a home one owns opens the furnishing view.
    setSaid({ shop, text: r.verdict === GATE.bought && item.kind === 'furniture' ? `${r.message}: place it at home (B)` : r.message })
    if (r.verdict !== GATE.bought) return
    // Bought is worn at once (the plan's instant buy and equip); the try-on, if it was this line, is now the look.
    const next = keeper.wear(item.id, look)
    if (next) onWear(next)
    if (trying !== null) onTry(null, null)
  }
  const wear = (item: StoreItem) => {
    const next = keeper.wear(item.id, look)
    if (!next) return
    onWear(next)
    // A try-on over the look would hide the line just put on: it comes off.
    if (trying !== null) onTry(null, null)
    setSaid({ shop, text: `${item.name}: worn` })
  }

  return (
    <div className="ui-zoom pointer-events-none absolute inset-0 z-30 flex items-end justify-end p-4 font-sans text-[13px] antialiased sm:items-center">
      <aside
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        aria-label={info.name}
        data-store={shop.kind}
        className={`pointer-events-auto flex max-h-[min(42rem,100%)] w-[min(26rem,100%)] flex-col rounded-3xl border backdrop-blur-2xl backdrop-saturate-150 ${glass} outline-none`}
      >
        <div className="flex items-start gap-3 px-5 pt-4">
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold leading-tight">{info.name}</div>
            <div className={`text-[11px] uppercase tracking-wide ${t.muted}`} data-arcade>{shop.arcade}</div>
            <p className={`mt-1 text-[12px] leading-snug ${t.muted}`}>{info.line}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={`shrink-0 rounded-full border px-2.5 py-1 text-[12px] ${t.pill}`}>×</button>
        </div>

        <div className={`mx-5 mt-3 flex items-baseline justify-between gap-2 rounded-2xl border px-3 py-2 ${t.rule}`} data-purse>
          <span className="font-semibold">Level {w.level()} · {credits(w.credits())}</span>
          <span className={`text-[11px] ${t.muted}`}>Your civic credits</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2 pt-1">
          {sections(selling).map(([group, list]) => (
            <section key={group} className="mt-3" data-group={group}>
              <h3 className={`text-[11px] font-semibold uppercase tracking-wide ${t.muted}`}>{group}</h3>
              <ul>
                {list.map((r) => (
                  <Row key={r.item.id} row={r} look={look} trying={trying === r.item.id} t={t} where={whereOf(r.item)} balance={w.credits()} onTry={tryOn} onBuy={buy} onWear={wear} onGo={onGo} />
                ))}
              </ul>
            </section>
          ))}
          {later.length > 0 && (
            <details className="mt-3" open={selling.length === 0} data-group="on-order">
              <summary className={`cursor-pointer text-[11px] font-semibold uppercase tracking-wide ${t.muted}`}>On order ({later.length})</summary>
              <ul>
                {later.map((r) => (
                  <li key={r.item.id} className={`flex items-baseline gap-2 border-b py-1.5 last:border-b-0 ${t.rule}`} data-item={r.item.id} data-verdict={r.verdict}>
                    <span className="min-w-0 flex-1">{r.item.name}</span>
                    <span className={`shrink-0 text-[11px] ${t.muted}`}>L{r.item.level} · {credits(r.item.price)}</span>
                  </li>
                ))}
              </ul>
              {later.some((r) => r.item.kind === 'wear') && <p className={`mt-1 text-[11px] leading-snug ${t.muted}`}>Worn lines arrive with the wardrobe update.</p>}
            </details>
          )}
        </div>

        <p className={`min-h-[1.25rem] px-5 text-[12px] ${t.muted}`} role="status" aria-live="polite" data-said>{said.shop === shop ? said.text : ''}</p>
        <div className={`flex items-center justify-between gap-2 border-t px-5 py-3 ${t.rule}`}>
          <span className={`text-[11px] ${t.muted}`}>{trying !== null ? 'Trying on: not kept unless bought' : mirror ? 'The mirror turns around you' : 'Your shadow and everyone else see what you wear'}</span>
          <button type="button" onClick={onClose} className={`rounded-full px-3.5 py-1.5 text-[12px] font-semibold ${t.primary}`} data-action="done">Done</button>
        </div>
      </aside>
    </div>
  )
}
