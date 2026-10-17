// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is every way out of a city that cannot start or has stopped, drawn by the page itself
 * because the installed iPhone app (display fullscreen: no address bar, no reload) and the Windows app (no browser
 * chrome) have no other: the recovery card (a failed boot, a graphics reset, a physics realm that stopped, a frame loop
 * that kept failing), the Ring-0 lock screen for a real audit failure, and the boot veil's 'Still starting' line. Each
 * offers Restart, a full page reload (never a remount: a fallback may already own the canvas, and a second engine
 * would stack GPU devices on a phone), focused from the start so Enter takes it, and the cards also offer 'Open the
 * console', the ?boot=tty shell that needs no GPU at all. A pad's A presses the focused button and its d-pad moves
 * between them (padNav.ts). The card's words come from bootFailure.ts; the raw message sits under Details with one
 * copyable line (the build, the adapter, the user agent) for a bug report.
 * What breaks if it is removed? A failed boot is a bare message with nothing to press, and a halted city a black
 * screen with no control.
 */
import { useEffect, useId, useRef, type JSX, type RefObject } from 'react'
import { MonolithLogo } from '../MonolithLogo.tsx'
import { isEditableTarget } from '../04_Connect_Hardware/input.ts'
import { detailsLine, type Failure } from './bootFailure.ts'
import { usePadNav } from './padNav.ts'

/** Restart: the page again from the top, the way the console's `boot` does it (a reload, never a remount). */
function restart(): void {
  window.location.reload()
}

/** The mouse back to the player (the city may have held it in pointer lock), then focus on the first button. */
function useTakeFocus(first: RefObject<HTMLButtonElement | null>): void {
  useEffect(() => {
    if (document.pointerLockElement) document.exitPointerLock()
    first.current?.focus()
  }, [first])
}

/**
 * Enter anywhere but a text field, a button or the card's Details line restarts while a way-out screen is up (focus
 * may have been clicked away from the button). A focused button and Details take Enter natively; the console beneath
 * leaves keys aimed at the screen alone (Terminal.tsx).
 */
function useEnterRestarts(active = true): void {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.repeat || isEditableTarget(e.target) || (e.target instanceof HTMLElement && e.target.closest('button, summary'))) return
      e.preventDefault()
      restart()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
}

const BUTTON = 'min-h-11 rounded-xl px-4 py-2 text-sm font-semibold outline-none focus-visible:ring-4 focus:ring-4'
/** Clear of an iPhone's notch, island and home bar (the page is viewport-fit=cover, the installed app full screen). */
const SAFE_PADDING = {
  padding: 'max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left))',
} as const

/**
 * The recovery card: the failure's headline and steps for this device, Restart (focused) and Open the console, the
 * WebGPU line where WebGPU is what is missing, and the details. Over everything but the Windows app's title bar.
 */
export function RecoveryCard({ failure, adapter = '', onConsole }: { failure: Failure; adapter?: string; onConsole(): void }): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const restartRef = useRef<HTMLButtonElement>(null)
  const openRef = useRef<HTMLButtonElement>(null)
  const title = useId(), body = useId()
  const openIn = failure.openIn ?? null
  useTakeFocus(openIn ? openRef : restartRef)
  usePadNav(root)
  useEnterRestarts()
  const line = detailsLine(adapter, typeof navigator === 'undefined' ? '' : navigator.userAgent)
  return (
    <div
      ref={root}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={title}
      aria-describedby={body}
      data-failure={failure.kind}
      className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/70 font-sans text-sm"
      style={SAFE_PADDING}
    >
      <div className="max-h-full w-full max-w-xl overflow-y-auto overscroll-contain rounded-2xl border border-white/70 bg-white/90 p-5 text-slate-900 shadow-2xl backdrop-blur-xl sm:p-6">
        <div className="mb-3 flex items-center gap-3">
          <MonolithLogo size={32} title="" />
          <h1 id={title} className="text-lg font-semibold leading-snug">{failure.headline}</h1>
        </div>
        <ul id={body} className="list-disc space-y-1.5 pl-5 leading-relaxed">
          {failure.steps.map((s) => <li key={s} className="break-words">{s}</li>)}
        </ul>
        <div className="mt-5 flex flex-wrap gap-2">
          {/* A browser that can run the city, one tap away (bootFailure.ts openInChrome): then it is the first button.
              React focuses an autoFocus button as it mounts, before useTakeFocus runs: only the button that is to have
              focus carries it, so focus never rests on Restart in between. */}
          {openIn && (
            <button ref={openRef} type="button" autoFocus onClick={() => { window.location.href = openIn.href }} className={`${BUTTON} bg-slate-900 text-white ring-slate-400 hover:bg-slate-700`}>
              {openIn.label}
            </button>
          )}
          <button ref={restartRef} type="button" autoFocus={!openIn} onClick={restart} className={`${BUTTON} ${openIn ? 'border border-slate-300 bg-white text-slate-900 ring-slate-300 hover:bg-slate-100' : 'bg-slate-900 text-white ring-slate-400 hover:bg-slate-700'}`}>
            Restart
          </button>
          <button type="button" onClick={onConsole} className={`${BUTTON} border border-slate-300 bg-white text-slate-900 ring-slate-300 hover:bg-slate-100`}>
            Open the console
          </button>
        </div>
        {failure.webgpuLine && <p className="mt-4 text-xs leading-relaxed text-slate-500">{failure.webgpuLine}</p>}
        <details className="mt-4 text-xs text-slate-600">
          <summary className="cursor-pointer select-none">Details</summary>
          <p className="mt-2 break-words font-mono">{failure.detail}</p>
          <p className="mt-2 select-all break-all font-mono text-[11px] text-slate-500" title="Select to copy">{line}</p>
        </details>
      </div>
    </div>
  )
}

/**
 * The Ring-0 lock screen, for a real audit failure only (bootFailure.ts haltClass 'audit'): its own copy, the reason,
 * and Restart, focused. The halt itself stays fatal: the city does not resume.
 */
export function LockScreen({ reason }: { reason: string }): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const restartRef = useRef<HTMLButtonElement>(null)
  useTakeFocus(restartRef)
  usePadNav(root)
  useEnterRestarts()
  return (
    <div ref={root} role="alertdialog" aria-live="assertive" className="absolute inset-0 z-[10000] flex items-center justify-center overflow-y-auto bg-black font-mono text-sm text-slate-200" style={SAFE_PADDING}>
      <div className="max-w-2xl">
        <div className="text-xs tracking-[0.3em] text-rose-400">[RING-0 FATAL]</div>
        <div className="mt-3 text-2xl font-semibold text-white">SYSTEM LOCKED</div>
        <div className="mt-2 break-words text-slate-300">{reason}</div>
        <div className="mt-6 text-xs text-slate-500">
          The Ring-0 audit found a broken invariant after the physics step. Physics and rendering are halted and the
          hardware bus has been disconnected. Restart to start the city again.
        </div>
        <button ref={restartRef} type="button" autoFocus onClick={restart} className={`${BUTTON} mt-6 border border-slate-500 bg-slate-900 font-mono text-white ring-rose-400/60 hover:bg-slate-800`}>
          Restart
        </button>
      </div>
    </div>
  )
}

/**
 * The boot veil's line once the city has been starting for a while (BootVeil.tsx): not a failure (a software adapter
 * takes minutes), only a way out for someone who has waited. Restart takes focus only if nothing else has it.
 */
export function StillStarting({ onConsole, stage }: { onConsole(): void; stage?: string }): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const restartRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body) restartRef.current?.focus()
  }, [])
  usePadNav(root)
  return (
    <div ref={root} role="status" className="absolute inset-x-4 bottom-6 flex flex-col items-center gap-3 font-sans text-sm text-slate-300 sm:bottom-10">
      <p className="text-center">Still starting{stage ? `: ${stage}` : ''}… a slow GPU can take a few minutes.</p>
      <div className="flex flex-wrap justify-center gap-2">
        <button ref={restartRef} type="button" onClick={restart} className={`${BUTTON} border border-white/25 bg-white/10 text-white ring-white/40 hover:bg-white/20`}>
          Restart
        </button>
        <button type="button" onClick={onConsole} className={`${BUTTON} border border-white/25 bg-transparent text-slate-200 ring-white/40 hover:bg-white/10`}>
          Open the console
        </button>
      </div>
    </div>
  )
}
