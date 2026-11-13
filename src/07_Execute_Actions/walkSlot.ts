// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the slot under the compact HUD's header where the first walk's strip stands on a
 * phone held upright: the HUD (Hud.tsx) holds an empty element out with holdWalkSlot, and the walk's card
 * (onboarding/FirstWalk.tsx) reads it through WALK_SLOT and puts its strip there through a portal: beside the
 * minimap, in the panels' own column, so the status chips under it and Sloane's chip (--hud-bottom) make room for it
 * like any panel. With no HUD on screen (the H key, a wide window) there is no slot, and the walk's card stays open.
 * A module of its own so neither component exports anything but itself.
 * What breaks if it is removed? The strip has nowhere to stand, and a phone's walk card cannot fold.
 */

let walkSlot: HTMLElement | null = null
const heard = new Set<() => void>()

/** The slot as an external store (useSyncExternalStore): the element while the HUD holds it out, else null. */
export const WALK_SLOT = Object.freeze({
  subscribe(onChange: () => void): () => void {
    heard.add(onChange)
    return () => { heard.delete(onChange) }
  },
  get: (): HTMLElement | null => walkSlot,
  server: (): HTMLElement | null => null,
})

/** The HUD's ref callback for the slot's element: held out while mounted, let go when it unmounts. */
export function holdWalkSlot(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return
  walkSlot = el
  for (const tell of heard) tell()
  return () => {
    if (walkSlot !== el) return
    walkSlot = null
    for (const tell of heard) tell()
  }
}
