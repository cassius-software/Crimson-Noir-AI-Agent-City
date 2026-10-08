// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the boot sequence: a black full-screen veil with the Monolith centred
 * on it while the GPU pipelines compile, then a fade from black straight into the first-person view. No
 * spinner, no bar, no text beyond an accessible label. It renders the same classes as the static splash
 * in index.html (whose <style> is their one definition), so when React mounts it takes over the page
 * pixel for pixel and nothing jumps.
 * What breaks if it is removed? The city pops in abruptly from a black page, half-built frames and the
 * first shader compiles are visible, and the HUD shows before there is anything to read.
 *
 * Layering: z-index 1000 (index.html) sits above the HUD, touch controls and Concierge, below the Ring-0
 * terminal (9999). The veil takes pointer events while it covers the page and none from the moment the
 * fade starts, so the first drag or tap during the fade already reaches the city.
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import { BRAND } from '../brand.ts'
import { MonolithLogo } from '../MonolithLogo.tsx'

const BOOT_VEIL = {
  /** Once ready, the mark stays at least this long, so a fast start still reads as a deliberate reveal. */
  holdMs: 500,
  fadeMs: 1200,
  /** prefers-reduced-motion: a short cross-fade instead of the slow reveal. */
  reducedFadeMs: 250,
  /** Extra wait before onDone if the transition never reports its end (hidden tab, no compositor). */
  graceMs: 150,
  ease: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const

type Phase = 'cover' | 'fade' | 'done'

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** `ready`: the first frames are on screen. `onDone` fires once, when the veil is fully transparent
 *  (it then renders nothing). */
export function BootVeil({ ready, onDone }: { ready: boolean; onDone(): void }): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>('cover')
  const [fadeMs, setFadeMs] = useState<number>(BOOT_VEIL.fadeMs)
  const onDoneRef = useRef(onDone)
  const reported = useRef(false)
  useEffect(() => { onDoneRef.current = onDone }, [onDone])

  // Ready → hold → fade. Once fading, `ready` going false again does not bring the veil back.
  useEffect(() => {
    if (!ready || phase !== 'cover') return
    const id = window.setTimeout(() => {
      setFadeMs(prefersReducedMotion() ? BOOT_VEIL.reducedFadeMs : BOOT_VEIL.fadeMs)
      setPhase('fade')
    }, BOOT_VEIL.holdMs)
    return () => window.clearTimeout(id)
  }, [ready, phase])

  // Fade → done on transitionend, or by timer should the transition never run.
  useEffect(() => {
    if (phase !== 'fade') return
    const id = window.setTimeout(() => setPhase('done'), fadeMs + BOOT_VEIL.graceMs)
    return () => window.clearTimeout(id)
  }, [phase, fadeMs])

  useEffect(() => {
    if (phase !== 'done' || reported.current) return
    reported.current = true
    onDoneRef.current()
  }, [phase])

  if (phase === 'done') return null
  const fading = phase === 'fade'
  return (
    <div
      className="boot-veil"
      role="img"
      aria-label={`${BRAND.name} is starting`}
      aria-hidden={fading || undefined}
      data-phase={phase}
      style={fading ? { opacity: 0, pointerEvents: 'none', transition: `opacity ${fadeMs}ms ${BOOT_VEIL.ease}` } : undefined}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && e.propertyName === 'opacity') setPhase('done')
      }}
    >
      <div className="boot-mark">
        <MonolithLogo title="" />
      </div>
    </div>
  )
}
