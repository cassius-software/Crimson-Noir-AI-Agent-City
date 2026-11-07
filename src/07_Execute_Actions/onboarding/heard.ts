// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It decides what of the visitor's spoken words Sloane takes (Concierge.tsx `heard`). The
 * on-device recogniser (08_Swarm/recruitment.ts) hears everything said near an open microphone; a recruitment
 * request is the recruiter's, and the rest reaches here. With a question or the goal prompt open on the card, the
 * whole line is the answer or the goal: the visitor opened that dialogue. Otherwise only a line that names Sloane
 * first ("Sloane, make it night", "hey Sloane, take me to the harbour") opens the goal dialogue, with the name
 * taken off, so the room's talk never becomes a goal. Pure: a function a Node test runs.
 * What breaks if it is removed? Every word near the microphone would be a goal, or none would.
 */

/** Sloane's name at the head of a line, with the small words people put before it and the pause after it. */
const ADDRESSED = /^(?:(?:hey|hi|ok|okay|so|right|please)[,\s]+)*sloane\b[\s,.:;!?-]*/i

/** The longest goal taken from speech (Concierge.tsx's field takes as much). */
export const HEARD_MAX = 200

/**
 * What Sloane takes of `text`: the whole line while `open` (a question or the goal prompt is up), else the rest of a
 * line that names Sloane first; null for anything else, and for a name alone.
 */
export function heardGoal(text: string, open: boolean): string | null {
  const t = (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim()
  if (!t) return null
  const m = ADDRESSED.exec(t)
  if (m) {
    const rest = t.slice(m[0].length).trim()
    return rest ? rest.slice(0, HEARD_MAX) : null
  }
  return open ? t.slice(0, HEARD_MAX) : null
}
