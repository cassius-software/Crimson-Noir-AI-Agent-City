// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the first walk's card (09_Cognition/firstWalk.ts, fed by useFirstWalk.ts): one
 * small panel in Sloane's own style (the onboarding's ink and titanium) that names the stage the visitor is on, says
 * the one thing to do in their device's words, tells them what it is in a line an eight-year-old follows, and unfolds
 * the five whys one at a time when they ask. It has no close button, no skip and no key that puts it away: the walk
 * ends when the console's exit program unlocks the city, and the card says so in plain words. Its accessible path is
 * one button per stage that has Sloane do the action for a visitor who cannot (a switch, a screen reader, a phone with
 * no keyboard): walk and turn, plan a goal, take them to a car, take them inside, open the console; on the last stage
 * the buttons type each line of the program into the console's prompt and run it, so the walk is completable with
 * taps alone. It stands clear of the HUD, the touch controls and Sloane's own card: on a wide screen under the
 * readout on the right, with Sloane's open card moved left of it (Concierge.tsx WIDE_BESIDE) from 60 rem across and,
 * in a narrower wide window, stepping aside while her card is open; on a compact or touch screen in the band above
 * the stick and the buttons and below her chip, stepping aside while her card is open (hers takes the same band); on
 * a phone held sideways between the thumbs, above the HUD's chips at the foot, and away while the visitor is at the
 * wheel there (the car's buttons fill the band); with the console open, at the foot of the screen under it.
 * What breaks if it is removed? The walk has no face: Sloane's lines are heard but never seen, and a visitor without
 * a keyboard or a mouse has no way through it.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { PROGRAM, type Beat, type StageCard } from '../../09_Cognition/firstWalk.ts'
import { besideRoom, cramped } from '../Concierge.tsx'
import { CONCIERGE_NAME } from './script.ts'

/** Where the card stands (full class strings, so Tailwind sees them). The card is inside the text size's zoom
 *  (index.css `.ui-zoom`), like the HUD it keeps clear of: the HUD's wide readout is 18 rem wide and about 14 rem tall
 *  under a 1.25 rem frame; the compact frame is 0.75 rem with the minimap row 8.75 rem tall, and Sloane's chip under
 *  the minimap ends at --chip-bottom (Concierge.tsx; zoomed lengths already), lower at the wheel. What is not zoomed is
 *  divided by --ui-zoom: the window's height (dvh), the touch buttons' top edge and left edge (--touch-top,
 *  --touch-left, window pixels; TouchControls.tsx), the stick's zone (11.5 rem of the unzoomed touch layer, 12.5 rem
 *  with its gaps), the top of the HUD's chips at the foot (--hud-foot, Hud.tsx) and the console's 45 dvh. Sideways,
 *  the band between the thumbs starts 10.5 rem down, clear of the header, the readout and Sloane's chip; its foot
 *  stands above the HUD's chips unless that would leave less than the card's own padding and border (1.875 rem), when
 *  it comes down over them rather than rise over the chip. Where even the whole band is short of 8 rem (a text size
 *  that zooms a sideways phone's height under 20 rem, Concierge.tsx CRAMPED_PX), the card rises over the HUD's rows,
 *  which take no taps, to the top of the screen, left of the minimap's column (7 rem wide under a 0.75 rem frame), and
 *  Sloane's chip steps aside for it. */
const AT = {
  wide: 'right-[max(1.25rem,env(safe-area-inset-right))] top-[calc(max(1.25rem,env(safe-area-inset-top))+16rem)] w-[20rem] max-h-[calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(1.25rem,env(safe-area-inset-top))_-_16rem_-_7.5rem)]',
  compact: 'left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+4.5rem)] mx-auto max-w-[28rem] max-h-[calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(calc(max(0.75rem,env(safe-area-inset-top))_+_8.75rem),calc(var(--chip-bottom,0px)_+_0.5rem))_-_max(0.75rem,env(safe-area-inset-bottom))_-_5rem)]',
  touch: 'left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] bottom-[calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)))_+_0.5rem)] mx-auto max-w-[28rem] max-h-[calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(calc(max(0.75rem,env(safe-area-inset-top))_+_8.75rem),calc(var(--chip-bottom,0px)_+_0.5rem))_-_max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)))_-_1rem)]',
  between: 'left-[calc(env(safe-area-inset-left,0px)_+_calc(12.5rem_/_var(--ui-zoom,1)))] right-[calc(calc(var(--touch-left,12rem)_/_var(--ui-zoom,1))_+_0.5rem)] bottom-[max(0px,min(max(max(0.75rem,env(safe-area-inset-bottom)),calc(calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))_+_0.5rem)),calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(0.75rem,env(safe-area-inset-top))_-_10.5rem_-_1.875rem)))] mx-auto max-w-[28rem] max-h-[calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(0.75rem,env(safe-area-inset-top))_-_10.5rem_-_max(0px,min(max(max(0.75rem,env(safe-area-inset-bottom)),calc(calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))_+_0.5rem)),calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(0.75rem,env(safe-area-inset-top))_-_10.5rem_-_1.875rem))))]',
  risen: 'left-[calc(env(safe-area-inset-left,0px)_+_calc(12.5rem_/_var(--ui-zoom,1)))] right-[max(calc(calc(var(--touch-left,12rem)_/_var(--ui-zoom,1))_+_0.5rem),calc(max(0.75rem,env(safe-area-inset-right))_+_7.5rem))] bottom-[max(0px,min(max(max(0.75rem,env(safe-area-inset-bottom)),calc(calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))_+_0.5rem)),calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(0.75rem,env(safe-area-inset-top))_-_1.875rem)))] mx-auto max-w-[28rem] max-h-[calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(0.75rem,env(safe-area-inset-top))_-_max(0px,min(max(max(0.75rem,env(safe-area-inset-bottom)),calc(calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))_+_0.5rem)),calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(0.75rem,env(safe-area-inset-top))_-_1.875rem))))]',
  console: 'left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] bottom-[max(0.75rem,env(safe-area-inset-bottom))] mx-auto max-w-[28rem] max-h-[calc(calc(55dvh_/_var(--ui-zoom,1))_-_4rem)]',
} as const

/** A media query as a stable external store (the HUD's and the Concierge's compact query). */
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
/** A short screen held sideways (Concierge.tsx's short layout in landscape): no room above the thumbs, so the card stands between them. */
const SIDEWAYS = mediaStore('(orientation: landscape) and (max-height: 499px)')
/**
 * SMALL at the text size's zoom: the window, measured in the zoom's pixels, is a small screen's. The wide place under
 * the HUD's readout is 24.75 rem down a window of zoomed rem, so at 200 % a laptop's 800 or 864 px leave the card a
 * sliver; there it takes the compact place at the foot instead (over the HUD, which at that zoom fills the window).
 * At 100 % it is SMALL itself. One store per zoom.
 */
const SQUEEZED = new Map<number, ReturnType<typeof mediaStore>>()
export function squeezedQuery(zoom: number): string {
  const z = Math.max(1, zoom)
  return `(max-width: ${Math.round(639 * z)}px), (max-height: ${Math.round(499 * z)}px)`
}
function squeezedAt(zoom: number): ReturnType<typeof mediaStore> {
  let store = SQUEEZED.get(zoom)
  if (!store) SQUEEZED.set(zoom, (store = mediaStore(squeezedQuery(zoom))))
  return store
}

export interface FirstWalkCardProps {
  /** Shown (pass false while the boot veil covers the page or the city is halted). */
  visible: boolean
  card: StageCard
  /** Sloane's newest line (the stage's ask, or a hint); the ask is shown until one comes. */
  beat: Beat | null
  /** The exit's doors so far. */
  exam: { seal: boolean; swarm: boolean }
  /** The touch overlay on screen (snapshot.supplier.touch), the console open. */
  overlay: boolean
  termOpen: boolean
  /** The accessible path: Sloane does this stage's action. */
  onShow(): void
  /** The last stage: a program line into the console's prompt, and the prompt run. */
  onType(line: string): void
  onRun(): void
  /** Sloane's spoken voice: called once with each new line. */
  onSay?(text: string): void
  /** Sloane's own card is open (Concierge onOpen): anywhere but a wide window from 60 rem across, where the two stand side by side, this card steps aside until hers closes. */
  crowded?: boolean
  /** At the wheel (the HUD's input mode): on a phone held sideways the car's buttons fill the band between the thumbs, and the card steps aside. */
  driving?: boolean
  /** The text size's zoom (access.ts scale / 100): the 60 rem are zoomed rem (Concierge.tsx besideRoom). */
  zoom?: number
}

export function FirstWalkCard({ visible, card, beat, exam, overlay, termOpen, onShow, onType, onRun, onSay, crowded = false, driving = false, zoom = 1 }: FirstWalkCardProps): JSX.Element | null {
  const compact = useSyncExternalStore(SMALL.subscribe, SMALL.matches, SMALL.server)
  const sideways = useSyncExternalStore(SIDEWAYS.subscribe, SIDEWAYS.matches, SIDEWAYS.server)
  const tight = squeezedAt(zoom)
  const squeezed = useSyncExternalStore(tight.subscribe, tight.matches, tight.server)
  // Room for Sloane's open card beside this one on a wide screen (Concierge.tsx's own query, at the same zoom).
  const room = besideRoom(zoom)
  const roomy = useSyncExternalStore(room.subscribe, room.matches, room.server)
  /** Between the thumbs of a phone held sideways (the console's place wins while it is open); risen over the HUD's rows
   *  where the text size leaves that band too short (Sloane's chip steps aside for it, Concierge.tsx). */
  const between = overlay && sideways && !termOpen
  const tightRoom = cramped(zoom)
  const risen = useSyncExternalStore(tightRoom.subscribe, tightRoom.matches, tightRoom.server)
  /** Side by side with Sloane's open card: only in the wide place, with the room for both. Anywhere else her card
   *  takes the band this one stands in (a phone's, a small window's, the centre of a window small only at the zoom). */
  const besideHers = !overlay && !compact && !squeezed && roomy
  /** Heard: up, and not stepping aside for Sloane's open card where the two cannot stand apart (her card is speaking). */
  const heard = visible && !(crowded && !termOpen && !besideHers)
  /** On screen: heard, and not at the wheel between a sideways phone's thumbs, where the car's buttons leave no band. It
   *  is back once the visitor is on foot; meanwhile Sloane still says each line (the stage the car finished hands over
   *  to the next one at the wheel, and its ask is heard there). */
  const shown = heard && !(between && driving)
  /** How many of the whys are unfolded (reset with the stage). */
  const [whys, setWhys] = useState(0)
  const [stage, setStage] = useState(card.stage)
  if (stage !== card.stage) { setStage(card.stage); setWhys(0) }
  const sayRef = useRef(onSay)
  useEffect(() => { sayRef.current = onSay }, [onSay])
  const said = useRef(-1)
  useEffect(() => {
    if (!beat || beat.id === said.current || !heard) return
    said.current = beat.id
    sayRef.current?.(beat.text)
  }, [beat, heard])
  if (!shown) return null

  const line = beat && beat.stage === card.stage ? beat.text : card.ask
  const at = termOpen ? AT.console : between ? (risen ? AT.risen : AT.between) : overlay ? AT.touch : compact || squeezed ? AT.compact : AT.wide
  const exitStage = card.stage === 'exam'
  return (
    // The text size's zoom (index.css .ui-zoom) on a layer of its own over the whole screen, which lets the city's
    // pointer through; the card takes it back.
    <div className="ui-zoom pointer-events-none absolute inset-0 z-[1050]">
      <section
        role="region"
        aria-label={`Your first walk, ${card.index} of ${card.count}: ${card.title}`}
        data-walk={card.stage}
        data-walk-index={card.index}
        className={`noir-panel pointer-events-auto absolute flex flex-col gap-2.5 overflow-y-auto overscroll-contain p-3.5 font-noir-text text-noir-titanium-200 antialiased ${at}`}
      >
        <header className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-noir-crimson" aria-hidden="true" />
          <span className="noir-label">Your first walk</span>
          <span className="ml-auto text-[12px] tabular-nums text-noir-titanium-400">{card.index} of {card.count}</span>
        </header>
        <div className="flex gap-1" aria-hidden="true">
          {Array.from({ length: card.count }, (_, i) => (
            <span key={i} className={`h-1 flex-1 rounded-full ${i < card.index - 1 ? 'bg-noir-titanium-400' : i === card.index - 1 ? 'bg-noir-crimson' : 'bg-noir-titanium-800'}`} />
          ))}
        </div>
        <h2 className="text-[17px] font-semibold leading-[22px] text-noir-titanium-100">{card.title}</h2>
        <p className="text-[15px] leading-5 text-noir-titanium-100" aria-live="polite" data-walk-line>
          <span className="text-noir-titanium-400">{CONCIERGE_NAME}: </span>{line}
        </p>
        <p className="text-[13px] leading-[18px] text-noir-titanium-400">{card.eli8}</p>

        {exitStage && (
          <div className="flex flex-col gap-1.5">
            <pre className="overflow-x-auto rounded-noir-control border border-noir-titanium-800 bg-noir-ink-2 px-3 py-2 font-noir-mono text-[12px] leading-[18px] text-noir-titanium-100" aria-label="The program">
              {PROGRAM.map((l, i) => <div key={i}>noir {l}</div>)}
            </pre>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Type the program">
              {PROGRAM.map((l, i) => (
                <button key={i} type="button" onClick={() => onType(`noir ${l}`)} className="noir-button" data-walk-line-button={i + 1}>Line {i + 1}</button>
              ))}
              <button type="button" onClick={onRun} className="noir-button is-active" data-walk-run>Run</button>
            </div>
            <div className="flex gap-3 text-[12px] text-noir-titanium-400" aria-live="polite" data-walk-doors>
              <span data-door="seal">{exam.seal ? '✓' : '○'} seal</span>
              <span data-door="swarm">{exam.swarm ? '✓' : '○'} swarm</span>
              <span data-door="city">○ city</span>
            </div>
          </div>
        )}

        {whys > 0 && (
          <ol className="flex flex-col gap-1.5 text-[13px] leading-[18px] text-noir-titanium-200" aria-label="The five whys" data-walk-whys={whys}>
            {card.whys.slice(0, whys).map((w, i) => <li key={i} className="border-l-2 border-noir-titanium-800 pl-2.5">{w}</li>)}
          </ol>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {whys < card.whys.length && (
            <button type="button" onClick={() => setWhys((n) => n + 1)} className="noir-button" data-walk-why>{whys === 0 ? 'Why?' : 'And why?'}</button>
          )}
          <button type="button" onClick={onShow} className="noir-button" data-walk-show>{card.show}</button>
        </div>
        <p className="text-[11px] leading-4 text-noir-titanium-600">No skip: the city opens when the program on the last card has run.</p>
      </section>
    </div>
  )
}
