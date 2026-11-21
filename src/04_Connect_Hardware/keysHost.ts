// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The on-screen keys (ScreenKeys.tsx) stand beside the app, mounted once above every shell
 * (the city, the onboarding, the console alone), so no prop reaches them and none comes back. This is the small
 * notice board between the two. The running city pins up what the keys need of it (player 1's pads as the game reads them,
 * the pads' lending, the way to open the console, whether a card that must be answered first is up); the keys pin up
 * what the city needs of them (whether they are away, offered or open, and for which field), which Sloane's card
 * reads so it does not fold while its line is being typed; and anyone may ask for the keys (`summonKeys`: a pad's
 * select button, the pad menu's Keyboard item). Each notice is a value and its listeners, the shape React's
 * useSyncExternalStore reads. Nothing here touches the page.
 * What breaks if it is removed? The keys cannot borrow the game's pads or find the console, and a card cannot tell
 * that its field is being typed in from them.
 */
import type { GamepadLike } from './web-hardware.d.ts'

/** A value with listeners. */
export class Shared<T> {
  private value: T
  private readonly listeners = new Set<() => void>()
  constructor(value: T) {
    this.value = value
  }
  get = (): T => this.value
  set(value: T): void {
    if (Object.is(value, this.value)) return
    this.value = value
    for (const l of [...this.listeners]) l()
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/** What the running city gives the keys. */
export interface KeysHost {
  /** Player 1's pads in the standard shape, as the game's last poll read them (Input.padViews). */
  pads(): readonly GamepadLike[]
  /** When that poll ran, on performance.now()'s clock (Input.polledAt): a list older than a few frames is not read. */
  polledAt(): number
  /**
   * Lends player 1's pads to a reader ('keys', 'menu'), or takes them back from it (Input.lend): the game has them
   * again once every reader has given them back, so the menu closing as it opens the keys does not hand the keys' pads
   * back to the game.
   */
  lend(owner: string, on: boolean): void
  /** Opens the console; its prompt takes the focus. */
  openConsole(): void
}

/** The keys: away, offered as a chip, or open. */
export type KeysMode = 'hidden' | 'peek' | 'open'

export interface KeysView {
  readonly mode: KeysMode
  /** The field the keys serve (an element of the page), null when away. */
  readonly field: unknown
}

/** The running city, or null where none runs (the onboarding, the console alone, a halted boot). */
export const keysHost = new Shared<KeysHost | null>(null)
/** A card that must be answered first is up (an action waiting for the OK, a halted city): the keys stand aside. */
export const keysBlocked = new Shared<boolean>(false)
/** What the keys are doing now. */
export const keysView = new Shared<KeysView>(Object.freeze({ mode: 'hidden', field: null }))

let summoner: (() => void) | null = null
let expecter: (() => void) | null = null

/** The keys register how they are summoned (ScreenKeys.tsx, once mounted); returns the unregistering. */
export function onSummonKeys(fn: () => void): () => void {
  summoner = fn
  return () => { if (summoner === fn) summoner = null }
}

/**
 * Asks for the keys: on the field that has the caret, else on the first field shown, else on the console's prompt
 * (the console is opened). Returns false when no keys are mounted to hear it.
 */
export function summonKeys(): boolean {
  if (!summoner) return false
  summoner()
  return true
}

/** The keys register how they are told a field is coming (ScreenKeys.tsx); returns the unregistering. */
export function onExpectKeys(fn: () => void): () => void {
  expecter = fn
  return () => { if (expecter === fn) expecter = null }
}

/**
 * Says the field a card is about to focus is asked for: the pad menu's Sloane item opens her goal dialogue, whose
 * field takes the focus a moment later and gets the keys open (keysDesk.ts DESK.summonMs).
 */
export function expectKeys(): void {
  expecter?.()
}

/** Whether the keys are open on `field` (a card asks this of its own field). */
export function keysOpenOn(view: KeysView, field: unknown): boolean {
  return view.mode === 'open' && field !== null && view.field === field
}
