// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the latch on the HUD's foot (Hud.tsx publishFoot, --hud-foot-peak). The compact
 * HUD's chips at the foot (the captions above all) grow and shrink as sounds come and go, and a phone held sideways
 * during the first walk reads their height to decide one thing: whether the band between the thumbs still holds the
 * walk's card, or Sloane's chip moves up to the top row and the card rises under it (Concierge.tsx CHIP_TOP.walk,
 * onboarding/FirstWalk.tsx AT.between). Read live, a car passing would flip both every few seconds, the chip jumping
 * from under a thumb about to tap it. So that choice reads the highest foot seen since the window took its size:
 * once the chips have needed the room, the layout keeps it until the window changes size (a rotation, a new
 * viewport), when the latch lets go and starts again from the foot of that moment. Pure: a function a Node test runs.
 * What breaks if it is removed? Sloane's chip and the walk's card jump between their two places with the captions.
 */

/** The latch: the window's size it was taken at, and the highest foot (window pixels) seen at that size. */
export interface FootPeak {
  readonly size: string
  readonly peak: number
}

/** The latch after a foot of `foot` window pixels is published in a window of `size` ("width x height"). */
export function nextFootPeak(prev: FootPeak | null, size: string, foot: number): FootPeak {
  const h = Number.isFinite(foot) ? Math.max(0, foot) : 0
  if (!prev || prev.size !== size) return { size, peak: h }
  return h > prev.peak ? { size, peak: h } : prev
}
