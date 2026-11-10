// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? A pad is the only input some players have (a handheld in its game mode, a TV, a couch), and
 * the ways out of a stopped city (the recovery card, the lock screen, the boot veil's 'Still starting' line) are
 * buttons. A halt has closed the game's own hardware bus (engine.ts halt) and the frame loop that read the pad has
 * stopped, so these screens read the pads themselves: A (the standard mapping's button 0) presses the button that has
 * focus, the d-pad moves focus between the screen's buttons. A press is an edge: a button already held when the screen
 * appears, or when its pad first shows up (a browser shows a page a pad only once one of its buttons is pressed, so
 * the A that pressed 'Open the console' can be the one that reveals it on the next page), does nothing until it is let
 * go, so the A that was driving a car cannot restart the city by accident. The
 * keyboard needs nothing here: the screens focus their first button, and Enter presses a focused button natively.
 * The same edge rule, for any buttons a screen names (padEdges), serves a card with more than A and the d-pad to read,
 * such as the home card's furnishing controls.
 * What breaks if it is removed? A player with only a pad has no way out of a failed boot or a halted city.
 */
import { useEffect, type RefObject } from 'react'

/** Standard-mapping buttons read here: A, then the d-pad (up, down, left, right). */
export const PAD = Object.freeze({ a: 0, up: 12, down: 13, left: 14, right: 15 })

/** What one poll of the pads asks for. */
export type PadAction = 'press' | 'next' | 'previous' | null

/** The part of a Gamepad read here. */
interface PadLike { buttons: readonly { pressed: boolean }[] }

/** The buttons padStep reads: A and the d-pad. */
const STEP_BUTTONS: readonly number[] = Object.freeze([PAD.a, PAD.up, PAD.down, PAD.left, PAD.right])

/**
 * Pure. The given standard-mapping `buttons` held across every pad now (as "pad:button", and each pad present as
 * "pad:"), and the buttons that went down on this poll: a button counts only when it is held now, was not held at the
 * previous poll, and its pad was there at the previous poll. So the first poll (an empty `prev`) only learns what is
 * held, and a pad that shows up with a button already down counts that button from its next press. A button held on
 * several pads counts once. `prev` is the `held` of the previous poll made with the same `buttons`: a button that poll
 * did not read reads as newly down.
 */
export function padEdges(prev: ReadonlySet<string>, pads: readonly (PadLike | null | undefined)[], buttons: readonly number[]): { held: Set<string>; down: Set<number> } {
  const held = new Set<string>()
  const down = new Set<number>()
  pads.forEach((p, i) => {
    if (!p) return
    held.add(`${i}:`)
    const there = prev.has(`${i}:`)
    for (const b of buttons) {
      if (!p.buttons[b]?.pressed) continue
      held.add(`${i}:${b}`)
      if (there && !prev.has(`${i}:${b}`)) down.add(b)
    }
  })
  return { held, down }
}

/**
 * Pure. The buttons held across every pad now (padEdges, for A and the d-pad), and the action this poll asks for: a
 * button counts only on the poll it goes down (it was not held at the previous poll) on a pad that was there at the
 * previous poll, A before the d-pad.
 */
export function padStep(prev: ReadonlySet<string>, pads: readonly (PadLike | null | undefined)[]): { held: Set<string>; action: PadAction } {
  const { held, down } = padEdges(prev, pads, STEP_BUTTONS)
  const action: PadAction = down.has(PAD.a) ? 'press' : down.has(PAD.down) || down.has(PAD.right) ? 'next' : down.has(PAD.up) || down.has(PAD.left) ? 'previous' : null
  return { held, action }
}

/**
 * Pure. The pads a screen reads: those `accept` takes by their index (the rest read as absent), or all of them. A pad
 * that comes into the accepted set this way counts from its next press, as a pad that first shows up does.
 */
export function padsFor<T>(pads: readonly (T | null | undefined)[], accept?: (padIndex: number) => boolean): readonly (T | null | undefined)[] {
  return accept ? pads.map((p, i) => (p && accept(i) ? p : null)) : pads
}

/**
 * The pads, or none where the browser has no Gamepad API (or refuses it, as a permissions policy can). A card that
 * reads more buttons than usePadNav does reads them through this and padEdges.
 */
export function readPads(): readonly (Gamepad | null)[] {
  try { return typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [] } catch { return [] }
}

/**
 * While `active`, reads the pads every animation frame for the buttons inside `root`: A presses the focused one (the
 * first when focus is elsewhere), the d-pad moves focus. The first poll only learns what is already held. `accept`
 * (stable across renders) limits it to some pads, by index: a card that is one player's, in split screen.
 */
export function usePadNav(root: RefObject<HTMLElement | null>, active = true, accept?: (padIndex: number) => boolean): void {
  useEffect(() => {
    if (!active) return
    let raf = 0
    let prev: Set<string> | null = null
    const poll = () => {
      const { held, action } = padStep(prev ?? new Set(), padsFor(readPads(), accept))
      const first = prev === null
      prev = held
      const el = root.current
      if (!first && action && el) {
        const buttons = [...el.querySelectorAll('button')].filter((b) => !b.disabled)
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (action === 'press') (buttons[at] ?? buttons[0])?.click()
        else if (buttons.length > 0) buttons[at < 0 ? 0 : (at + (action === 'next' ? 1 : buttons.length - 1)) % buttons.length].focus()
      }
      raf = requestAnimationFrame(poll)
    }
    raf = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(raf)
  }, [root, active, accept])
}
