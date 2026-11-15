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
 * go, so the A that was driving a car cannot restart the city by accident. With one hand on the pad (access.ts `pad`,
 * written onto <html> as data-pad) the shared centre button, start, does what that hand's side cannot: it presses for
 * the left hand (the d-pad moves), it moves focus for the right (A presses). Never a shoulder: L1 and R1 are that
 * hand's glance, which a card waiting for the OK leaves live. The
 * keyboard needs nothing here: the screens focus their first button, and Enter presses a focused button natively.
 * The same edge rule, for any buttons a screen names (padEdges), serves a card with more than A and the d-pad to read,
 * such as the home card's furnishing controls.
 * One press does one thing: while the on-screen keys or the pad's menu have the pads (borrowPads), every screen that
 * reads them through readPads sees none, so the south button that types a letter does not also press a card's
 * button, and by the edge rule a button still held when the pads come back counts from its next press.
 * What breaks if it is removed? A player with only a pad has no way out of a failed boot or a halted city.
 */
import { useEffect, type RefObject } from 'react'
import { keysBlocked, keysHost } from '../04_Connect_Hardware/keysHost.ts'
import { isLiveField } from '../04_Connect_Hardware/textEntry.ts'
import type { KeysPadLike } from '../04_Connect_Hardware/keysPad.ts'
import type { PadHand } from '../04_Connect_Hardware/gamepad.ts'

/** Standard-mapping buttons read here: A, the d-pad (up, down, left, right), and start, which either hand reaches. */
export const PAD = Object.freeze({ a: 0, up: 12, down: 13, left: 14, right: 15, start: 9 })

/** What one poll of the pads asks for. */
export type PadAction = 'press' | 'next' | 'previous' | null

/** The part of a Gamepad read here. */
interface PadLike { buttons: readonly { pressed: boolean }[] }

/** The buttons padStep reads: A and the d-pad, and start too with one hand (it does what that hand's side cannot). */
const STEP_BUTTONS: readonly number[] = Object.freeze([PAD.a, PAD.up, PAD.down, PAD.left, PAD.right])
const ONE_HAND_BUTTONS: readonly number[] = Object.freeze([...STEP_BUTTONS, PAD.start])

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
 * Pure. The buttons held across every pad now (padEdges, for A and the d-pad, and start with one hand), and the action
 * this poll asks for: a button counts only on the poll it goes down (it was not held at the previous poll) on a pad
 * that was there at the previous poll, A before the d-pad. One `hand` adds start: it presses for the left hand, it
 * moves on for the right (a hand chosen while start is held counts that start once). Both hands read what they did
 * before padEdges.
 */
export function padStep(prev: ReadonlySet<string>, pads: readonly (PadLike | null | undefined)[], hand: PadHand = 'both'): { held: Set<string>; action: PadAction } {
  const { held, down } = padEdges(prev, pads, hand === 'both' ? STEP_BUTTONS : ONE_HAND_BUTTONS)
  const press = down.has(PAD.a) || (hand === 'left' && down.has(PAD.start))
  const next = down.has(PAD.down) || down.has(PAD.right) || (hand === 'right' && down.has(PAD.start))
  const action: PadAction = press ? 'press' : next ? 'next' : down.has(PAD.up) || down.has(PAD.left) ? 'previous' : null
  return { held, action }
}

/** The pad hand the accessibility settings chose (access.ts applyAccess writes it onto <html> as data-pad), else both. */
export function pageHand(): PadHand {
  const v = typeof document !== 'undefined' ? document.documentElement.dataset.pad : undefined
  return v === 'left' || v === 'right' ? v : 'both'
}

/**
 * Pure. The pads a screen reads: those `accept` takes by their index (the rest read as absent), or all of them. A pad
 * that comes into the accepted set this way counts from its next press, as a pad that first shows up does.
 */
export function padsFor<T>(pads: readonly (T | null | undefined)[], accept?: (padIndex: number) => boolean): readonly (T | null | undefined)[] {
  return accept ? pads.map((p, i) => (p && accept(i) ? p : null)) : pads
}

const NO_PADS: readonly (Gamepad | null)[] = Object.freeze([])
/** Who has borrowed the pads from every screen that reads them here (null: nobody). */
let borrower: string | null = null

/**
 * Takes the pads for one reader (the on-screen keys, the pad's menu): until it gives them back, readPads answers with
 * none, so no card acts on a press meant for the borrower. Returns the giving back, which does nothing once another
 * reader has borrowed them since (the menu opening the keys).
 */
export function borrowPads(owner: string): () => void {
  borrower = owner
  return () => { if (borrower === owner) borrower = null }
}

/** Who has the pads (null: every screen reads them as usual). */
export function padsBorrower(): string | null {
  return borrower
}

/** The browser's pads, whoever has borrowed them: the borrower's own read. */
export function readPadsNow(): readonly (Gamepad | null)[] {
  try { return typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : NO_PADS } catch { return NO_PADS }
}

/** The game's own read of player 1's pads is taken while it is this fresh, ms; older (no city, a halted one), the browser's. */
const HOST_FRESH_MS = 250

/** A pad as the borrowers read it: the standard shape, and its id (for its layout's printed names). */
export type ReadPad = KeysPadLike & { readonly id: string }

/**
 * The pads a borrower reads (the on-screen keys, the pad's menu): player 1's as the running city's last poll read
 * them, remapped to the standard shape (Input.padViews), while that poll is fresh; else the browser's own pads in the
 * standard shape (the rest cannot be read by position). `fresh` says which: where it is true, the city also reads
 * the pads' menu and keys buttons itself (App.tsx), so a borrower does not act on them twice.
 */
export function playerPads(now: number = typeof performance !== 'undefined' ? performance.now() : 0): { readonly pads: readonly ReadPad[]; readonly fresh: boolean } {
  const host = keysHost.get()
  if (host !== null && now - host.polledAt() < HOST_FRESH_MS) return { pads: host.pads(), fresh: true }
  const out: ReadPad[] = []
  for (const p of readPadsNow()) if (p && p.connected && p.mapping === 'standard') out.push(p)
  return { pads: out, fresh: false }
}

/**
 * The pads, or none where the browser has no Gamepad API (or refuses it, as a permissions policy can), and none
 * while a reader has borrowed them (borrowPads). A card that reads more buttons than usePadNav does reads them
 * through this and padEdges.
 */
export function readPads(): readonly (Gamepad | null)[] {
  return borrower === null ? readPadsNow() : NO_PADS
}

/**
 * While `active`, reads the pads every animation frame for the buttons inside `root`: A presses the focused one (the
 * first when focus is elsewhere), the d-pad moves focus. The first poll only learns what is already held. `accept`
 * (stable across renders) limits it to some pads, by index: a card that is one player's, in split screen. With the
 * caret in a text field (the console shell's prompt, where the on-screen keys serve a pad), A presses nothing: the
 * player may be typing there, and the d-pad reaches the buttons first (the shell's Back to the city among them).
 */
/**
 * Whether the caret is in a text field (the console's prompt), with no card that must be answered first over it. Not
 * whether the keys show yet: the first press of a pad is read here in the same frame it tells the keys a pad is in use.
 */
function typingHere(): boolean {
  return !keysBlocked.get() && isLiveField(document.activeElement)
}

export function usePadNav(root: RefObject<HTMLElement | null>, active = true, accept?: (padIndex: number) => boolean): void {
  useEffect(() => {
    if (!active) return
    let raf = 0
    let prev: Set<string> | null = null
    const poll = () => {
      const { held, action } = padStep(prev ?? new Set(), padsFor(readPads(), accept), pageHand())
      const first = prev === null
      prev = held
      const el = root.current
      if (!first && action && el) {
        const buttons = [...el.querySelectorAll('button')].filter((b) => !b.disabled)
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (action === 'press') (buttons[at] ?? (typingHere() ? null : buttons[0]))?.click()
        else if (buttons.length > 0) buttons[at < 0 ? 0 : (at + (action === 'next' ? 1 : buttons.length - 1)) % buttons.length].focus()
      }
      raf = requestAnimationFrame(poll)
    }
    raf = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(raf)
  }, [root, active, accept])
}
