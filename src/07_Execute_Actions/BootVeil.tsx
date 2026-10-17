// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the boot sequence: a black full-screen veil with the Monolith centred
 * on it while the GPU pipelines compile, then a fade from black straight into the first-person view. No
 * spinner, no bar, and no text beyond an accessible label until the city has kept the player waiting
 * BOOT_VEIL.slowMs of visible time: then one quiet line says it is still starting and offers Restart and
 * the console (RecoveryCard.tsx StillStarting). That line never fails the boot (a software adapter takes
 * minutes), it only gives a player who has waited a way out. It renders the same classes as the static
 * splash in index.html (whose <style> is their one definition), so when React mounts it takes over the page
 * pixel for pixel and nothing jumps.
 * What breaks if it is removed? The city pops in abruptly from a black page, half-built frames and the
 * first shader compiles are visible, the HUD shows before there is anything to read, and a hung boot is a
 * black screen with nothing to press.
 *
 * Layering: z-index 1000 (index.html) sits above the HUD, touch controls and Concierge, below the Ring-0
 * terminal (9999). The veil takes pointer events while it covers the page and none from the moment the
 * fade starts, so the first drag or tap during the fade already reaches the city.
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import { BRAND } from '../brand.ts'
import { MonolithLogo } from '../MonolithLogo.tsx'
import { StillStarting } from './RecoveryCard.tsx'
import { waitedFor } from './bootFailure.ts'


const BOOT_VEIL = {
  /** Once ready, the mark stays at least this long, so a fast start still reads as a deliberate reveal. */
  holdMs: 500,
  fadeMs: 1200,
  /** prefers-reduced-motion: a short cross-fade instead of the slow reveal. */
  reducedFadeMs: 250,
  /** Extra wait before onDone if the transition never reports its end (hidden tab, no compositor). */
  graceMs: 150,
  /**
   * Visible time (ms) without a first frame before the 'Still starting' line and its buttons show. A hint, never a
   * timeout: nothing is rejected, so the software adapter's minutes-long boot (the browser smoke) still completes.
   */
  slowMs: 20_000,
  ease: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const

type Phase = 'cover' | 'fade' | 'done'

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** `ready`: the first frames are on screen. `onDone` fires once, when the veil is fully transparent
 *  (it then renders nothing). `onConsole`: the console's way out on the 'Still starting' line (none, no line).
 *  `stage`: what the city is doing, named on that line (bootFailure.ts BOOT_STAGE). */
export function BootVeil({ ready, onDone, onConsole, stage }: { ready: boolean; onDone(): void; onConsole?: () => void; stage?: string }): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>('cover')
  const [fadeMs, setFadeMs] = useState<number>(BOOT_VEIL.fadeMs)
  const [slow, setSlow] = useState(false)
  const onDoneRef = useRef(onDone)
  const reported = useRef(false)
  useEffect(() => { onDoneRef.current = onDone }, [onDone])

  // Not ready after slowMs of visible time: the line with its buttons (hidden time, as on a phone switched away, is
  // not counted). Once shown it stays until the veil fades.
  useEffect(() => {
    if (ready || slow || phase !== 'cover' || !onConsole) return
    let waited = 0
    let last = performance.now()
    const id = window.setInterval(() => {
      const t = performance.now()
      waited = waitedFor(waited, t - last, document.hidden)
      last = t
      if (waited >= BOOT_VEIL.slowMs) setSlow(true)
    }, 1000)
    return () => window.clearInterval(id)
  }, [ready, slow, phase, onConsole])

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
      role={slow ? undefined : 'img'}
      aria-label={slow ? undefined : `${BRAND.name} is starting`}
      aria-hidden={fading || undefined}
      data-phase={phase}
      style={fading ? { opacity: 0, pointerEvents: 'none', transition: `opacity ${fadeMs}ms ${BOOT_VEIL.ease}` } : undefined}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && e.propertyName === 'opacity') setPhase('done')
      }}
    >
      <div className="boot-mark" role={slow ? 'img' : undefined} aria-label={slow ? `${BRAND.name} is starting` : undefined}>
        <MonolithLogo title="" />
      </div>
      {slow && !fading && onConsole && <StillStarting onConsole={onConsole} stage={stage} />}
    </div>
  )
}
