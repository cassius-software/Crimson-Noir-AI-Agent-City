// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the numbers of the first walk's folding card (FirstWalk.tsx), the card a phone
 * held upright shows in the band between Sloane's chip and the thumbs: how far the visitor goes before an open card
 * folds to its strip, and how many lines of Sloane's line the short card shows. That band is whatever the phone leaves
 * (131 px of a 360 x 552 page, 71 beside a car, 400 on a tall phone), so the lines are counted from the band the
 * browser laid out rather than fixed: a card that fits is never cut through its button, and a tall phone is not held
 * to three lines. Pure: functions a Node test runs.
 * What breaks if it is removed? The short card goes back to a fixed cut, and on the phone it was made for its button
 * is cut by the band beside a car.
 */

/** Ground covered (walked or driven, metres) since the card opened that folds it: the visitor is under way. Ten is
 *  some seven seconds' walk, time to read the short card when a line comes with a thumb already on the stick (a fresh
 *  touch anywhere outside the card folds it at once). */
export const FOLD_METRES = 10
/** The short card's share of Sloane's line, in lines: as many as its band has room for (fitLines), within these. */
export const LINES_MIN = 2
export const LINES_MAX = 6
/** The share before the card has been measured (the first render; replaced before the browser paints). */
export const UNMEASURED: Readonly<{ lines: number; whole: boolean }> = Object.freeze({ lines: 3, whole: false })

/**
 * How many lines of Sloane's line the short card shows, and whether the card then fits its band whole. `room` is the
 * band (the card's greatest height), `rest` everything in the card but the line (padding, border, gaps, the buttons),
 * `line` one line's height and `text` the whole line's height, all in the card's own pixels. Fewer than LINES_MIN are
 * never shown (the card scrolls instead, and is not whole), nor more than LINES_MAX (More has the rest). A measure
 * that is not a number (a card not laid out yet) is the unmeasured share.
 */
export function fitLines(room: number, rest: number, line: number, text: number): { lines: number; whole: boolean } {
  if (!(room > 0) || !(line > 0) || !Number.isFinite(rest) || !Number.isFinite(text)) return UNMEASURED
  const lines = Math.max(LINES_MIN, Math.min(LINES_MAX, Math.floor((room - rest) / line)))
  return { lines, whole: rest + Math.min(lines * line, Math.max(0, text)) <= room + 0.5 }
}
