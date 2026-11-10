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
 * the stick and the buttons; with the console open, at the foot of the screen under it.
 * What breaks if it is removed? The walk has no face: Sloane's lines are heard but never seen, and a visitor without
 * a keyboard or a mouse has no way through it.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { PROGRAM, type Beat, type StageCard } from '../../09_Cognition/firstWalk.ts'
import { BESIDE_ROOM_QUERY } from '../Concierge.tsx'
import { CONCIERGE_NAME } from './script.ts'

/** Where the card stands (full class strings, so Tailwind sees them). The HUD's wide readout is 18 rem wide and about
 *  14 rem tall under a 1.25 rem frame; the compact frame is 0.75 rem with the minimap row 8.75 rem tall; the touch stick's
 *  zone is 11.5 rem tall and the buttons' top edge is --touch-top (TouchControls.tsx); the console is 45 dvh tall. */
const AT = {
  wide: 'right-[max(1.25rem,env(safe-area-inset-right))] top-[calc(max(1.25rem,env(safe-area-inset-top))+16rem)] w-[20rem] max-h-[calc(100dvh_-_max(1.25rem,env(safe-area-inset-top))_-_16rem_-_7.5rem)]',
  compact: 'left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+4.5rem)] mx-auto max-w-[28rem] max-h-[calc(100dvh_-_max(0.75rem,env(safe-area-inset-top))_-_8.75rem_-_max(0.75rem,env(safe-area-inset-bottom))_-_5rem)]',
  touch: 'left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] bottom-[calc(max(var(--touch-top,10.5rem),11.5rem)+0.5rem)] mx-auto max-w-[28rem] max-h-[calc(100dvh_-_max(0.75rem,env(safe-area-inset-top))_-_8.75rem_-_max(var(--touch-top,10.5rem),11.5rem)_-_1rem)]',
  console: 'left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] bottom-[max(0.75rem,env(safe-area-inset-bottom))] mx-auto max-w-[28rem] max-h-[calc(55dvh_-_4rem)]',
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
/** Room for Sloane's open card beside this one on a wide screen (Concierge.tsx's own query). */
const ROOMY = mediaStore(BESIDE_ROOM_QUERY)

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
  /** Sloane's own card is open (Concierge onOpen): in a wide window under 60 rem across, too narrow for the two side by side, this card steps aside until hers closes. */
  crowded?: boolean
}

export function FirstWalkCard({ visible, card, beat, exam, overlay, termOpen, onShow, onType, onRun, onSay, crowded = false }: FirstWalkCardProps): JSX.Element | null {
  const compact = useSyncExternalStore(SMALL.subscribe, SMALL.matches, SMALL.server)
  const roomy = useSyncExternalStore(ROOMY.subscribe, ROOMY.matches, ROOMY.server)
  /** On screen: shown, and not stepping aside for Sloane's open card in a wide window too narrow for both. */
  const shown = visible && !(crowded && !termOpen && !overlay && !compact && !roomy)
  /** How many of the whys are unfolded (reset with the stage). */
  const [whys, setWhys] = useState(0)
  const [stage, setStage] = useState(card.stage)
  if (stage !== card.stage) { setStage(card.stage); setWhys(0) }
  const sayRef = useRef(onSay)
  useEffect(() => { sayRef.current = onSay }, [onSay])
  const said = useRef(-1)
  useEffect(() => {
    if (!beat || beat.id === said.current) return
    // A line that comes while the card is away waits for it, except a hint: that came while the visitor was busy in
    // another card (the wardrobe, a shop's, a home's, Sloane's own), and closing that card has often done what it asks,
    // so it is let go unspoken rather than said a moment before the next stage's line cuts it off.
    if (!shown) { if (beat.kind === 'hint') said.current = beat.id; return }
    said.current = beat.id
    sayRef.current?.(beat.text)
  }, [beat, shown])
  if (!shown) return null

  const line = beat && beat.stage === card.stage ? beat.text : card.ask
  const at = termOpen ? AT.console : overlay ? AT.touch : compact ? AT.compact : AT.wide
  const exitStage = card.stage === 'exam'
  return (
    <section
      role="region"
      aria-label={`Your first walk, ${card.index} of ${card.count}: ${card.title}`}
      data-walk={card.stage}
      data-walk-index={card.index}
      className={`noir-panel absolute z-[1050] flex flex-col gap-2.5 overflow-y-auto overscroll-contain p-3.5 font-noir-text text-noir-titanium-200 antialiased ${at}`}
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
  )
}
