// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the card the operator sees when an agent's answer proposed a city action (acts.ts;
 * one at a time): who proposes what, in the city's own words, and two buttons, Refuse and Allow. Nothing runs until
 * Allow, and the card runs nothing itself: it tells the host (App.tsx), which allows or refuses through the operator
 * bridge, where the proposal runs under the proposer's tether. With the console closed it takes focus on Refuse (Enter
 * and Space press the focused button natively), Y allows and N refuses from the keyboard, a pad's south face button
 * presses the focused button and its d-pad moves between them (padNav.ts; the game's own reading of that button is
 * shielded meanwhile, input.ts), and a tap presses either. With the console open the prompt keeps the keyboard and the
 * line path (act ok, act no, y, n) is the way, so the card only shows, except that a Y or N typed while one of its own
 * buttons has focus (a click or a d-pad press moved it there) answers, since the prompt is not getting that key. It is
 * drawn by the page, independent of the canvas, so it shows with drawing off; it is never mounted on Track B (no
 * engine). Esc is the console's, not the card's.
 * What breaks if it is removed? With the console closed a proposal has nothing to press: it waits until the console
 * opens, and a player with only a pad or a touch screen cannot answer it at all.
 */
import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { isEditableTarget } from '../04_Connect_Hardware/input.ts'
import type { PendingAct } from './operator.ts'
import { usePadNav } from './padNav.ts'

/** The card's fixed words (every one passes the 14A screen; no exclamation mark, no syntax: actWiring.test.ts). */
const HEADING = 'City action'
const PROMISE = 'Nothing changes until you allow it. It runs only while they stay with you.'
const HINT_KEYS = 'Y allows · N refuses · the south face button presses'
const HINT_CONSOLE = 'Type y or n in the console'

const BUTTON = 'min-h-11 rounded-xl px-4 py-2 text-sm font-semibold outline-none focus-visible:ring-4 focus:ring-4'
/** Clear of an iPhone's notch, island and home bar (RecoveryCard.tsx has the same; the page is viewport-fit=cover). */
const SAFE_PADDING = {
  padding: 'max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left))',
} as const

/**
 * The clamp note in plain words: `clamped from 9` on `light haze 4` reads `(the model asked for 9; the most it goes is
 * 4)`, and a value raised to a dial's floor reads `the least it goes is`. Any other note is shown as it came.
 */
function noteWords(act: PendingAct): string | null {
  if (!act.note) return null
  const asked = Number(act.note.match(/^clamped from (-?\d+(?:\.\d+)?)$/)?.[1])
  const got = Number(act.canonical.slice(act.canonical.lastIndexOf(' ') + 1))
  if (!Number.isFinite(asked) || !Number.isFinite(got)) return `(${act.note})`
  return `(the model asked for ${asked}; the ${asked > got ? 'most' : 'least'} it goes is ${got})`
}

/**
 * One proposal, waiting: `act` is the one the bridge's acts.follow last proposed, `termOpen` whether the console owns
 * the keyboard. Refuse comes first in DOM order and takes focus (a pad's south face button presses the focused button,
 * the first when none is focused), so the quick answer is the safe one; both buttons are dead after the first press.
 */
export function ActCard({ act, termOpen, onAllow, onRefuse }: { act: PendingAct; termOpen: boolean; onAllow(): void; onRefuse(): void }): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const refuseRef = useRef<HTMLButtonElement>(null)
  const title = useId(), body = useId()
  // One decision per proposal: the buttons and the keys are dead after the first press, until the next proposal.
  const [decidedFor, setDecidedFor] = useState<number | null>(null)
  const decided = decidedFor === act.seq
  const decide = (choice: () => void): void => {
    if (decided) return
    setDecidedFor(act.seq)
    choice()
  }
  // The mouse back to the player (the city may hold it in pointer lock), then focus on Refuse: only while the console
  // is closed (open, the prompt keeps focus and the line path is the keyboard path), again for every new proposal.
  useEffect(() => {
    if (termOpen) return
    if (document.pointerLockElement) document.exitPointerLock()
    refuseRef.current?.focus({ preventScroll: true })
  }, [termOpen, act.seq])
  // Y allows, N refuses, from anywhere but a text field, while the console is closed (open, y and n are console lines).
  // Bubble phase, after the console's own capture listener; a held key repeats nothing. No Escape: Esc is the console's.
  useEffect(() => {
    if (termOpen || decided) return
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return
      const key = e.key.toLowerCase()
      if (key !== 'y' && key !== 'n') return
      e.preventDefault()
      setDecidedFor(act.seq)
      if (key === 'y') onAllow()
      else onRefuse()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [termOpen, decided, act.seq, onAllow, onRefuse])
  usePadNav(root)
  // The console open and focus inside the card (a click, or the d-pad): Y and N answer here, since the prompt does not
  // see them (Terminal.tsx leaves keys aimed at an alertdialog alone); any other key stays where it is.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!termOpen || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
    const key = e.key.toLowerCase()
    if (key !== 'y' && key !== 'n') return
    e.preventDefault()
    e.stopPropagation()
    decide(key === 'y' ? onAllow : onRefuse)
  }
  const note = noteWords(act)
  return (
    <div
      ref={root}
      onKeyDown={onKeyDown}
      role="alertdialog"
      aria-labelledby={title}
      aria-describedby={body}
      data-act={act.seq}
      className="pointer-events-none fixed inset-0 z-[10000] flex items-center justify-center font-sans text-sm"
      style={SAFE_PADDING}
    >
      {/* The root lets the pointer through to the city (a drag still looks around, the touch stick still walks); only
          the card itself takes taps and clicks. No scrim: the city goes on, and E or a walk-off still ends the proposal. */}
      <div className="pointer-events-auto w-full max-w-sm rounded-2xl border border-white/15 bg-black/80 p-5 text-slate-100 shadow-2xl backdrop-blur-xl">
        <h2 id={title} className="text-base font-semibold leading-snug text-white">{HEADING}</h2>
        <div id={body} className="mt-2 space-y-2 leading-relaxed">
          <p className="text-slate-300">{act.who} proposes:</p>
          <p className="break-words">
            <span className="font-semibold text-white">{act.sentence}</span>
            {note && <span className="text-slate-400"> {note}</span>}
          </p>
          <p className="text-slate-300">{PROMISE}</p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button ref={refuseRef} type="button" disabled={decided} onClick={() => decide(onRefuse)} className={`${BUTTON} border border-white/25 bg-white/10 text-white ring-white/40 hover:bg-white/20 disabled:opacity-50`}>Refuse</button>
          <button type="button" disabled={decided} onClick={() => decide(onAllow)} className={`${BUTTON} bg-white text-slate-900 ring-slate-300 hover:bg-slate-200 disabled:opacity-50`}>Allow</button>
        </div>
        <p className="mt-3 text-xs text-slate-400">{termOpen ? HINT_CONSOLE : HINT_KEYS}</p>
      </div>
    </div>
  )
}
