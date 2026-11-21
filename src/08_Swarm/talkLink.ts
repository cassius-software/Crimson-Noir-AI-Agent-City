// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It decides who the player can talk to and when a conversation holds: the nearest person
 * in reach, on the floor, on screen and unwalled, held steady so the label never flickers, and released when they
 * walk on. It has two parts.
 * - `nearestPeople` is the scan. Over the crowd's pose copy (x, feet y, z and heading per row, the engine's
 *   crowdPose), it lists the few people within TALK_REACH of the player and on their floor, nearest first. It skips
 *   the player's own body (row 0), the rows the caller names (the fallen, who wear rigs) and the hidden rows that
 *   contact.ts folds below the street. The engine keeps the ones it sees on screen, scores them with `talkScore`
 *   (straight ahead beats a little closer at the screen's edge), asks about walls for the best few only, and hands
 *   the result to the controller as a TalkScan.
 * - `linkStep` is the link: a pure reducer from the link and one event (a scan, a press, an ending, being blocked) to
 *   the next link and, only when a conversation closes, why it closed. A nominee is shown only after TALK_CONFIRM
 *   scans in a row, and replaced only by one clearly better (below TALK_SWITCH of its score) on as many. A shown
 *   person stays while they are there, within TALK_KEEP and unwalled. The partner of a conversation that just closed
 *   is not offered again for TALK_AGAIN_MS, and a running player is offered nobody. An open conversation never
 *   changes partner: it closes when the partner is gone, past TALK_RELEASE, past TALK_KEEP while nothing is in
 *   progress, or behind a wall for TALK_WALLED_MS.
 * Pure: no three, no DOM, no clock of its own (a scan carries the caller's `now`), no randomness, and the scan
 * allocates nothing. The controller (07_Execute_Actions/talk.ts) drives it; the engine fills the scans.
 * What breaks if it is removed? Nobody can be talked to.
 */
import { RELEASE_DISTANCE, SUMMON_ACCEPT } from '../03_Spawn_Agents/skills.ts'
import { HIDDEN_Y } from '../07_Execute_Actions/contact.ts'

/**
 * Farthest a person may stand from the player to be offered, m (over the ground). It is inside the head's gaze reach
 * (humanoid.ts GAZE.reach, 4.5 m), so the person offered can turn their head to the player.
 */
export const TALK_REACH = 4
/** Farthest a person's feet may be above or below the player's for them to share a floor, m. */
export const TALK_FLOOR = 1.2
/**
 * A shown person stays offered within this, and an open conversation with nothing in progress holds within it, m: the
 * distance a summoned person is accepted from (skills.ts SUMMON_ACCEPT).
 */
export const TALK_KEEP = SUMMON_ACCEPT
/** An open conversation closes past this, whatever is in progress, m: where a recruit's tether breaks (skills.ts). */
export const TALK_RELEASE = RELEASE_DISTANCE
/** At most this many people come back from one scan, nearest first. */
export const TALK_POOL = 8
/** Walls are asked about for this many of a scan's best-scored people at most (each ask casts a ray). */
export const TALK_WALL_CHECKS = 3
/** A shown person is replaced only by someone scoring below this share of their own score. */
export const TALK_SWITCH = 0.75
/** Scans in a row a person must lead to be shown (or to replace the one shown). */
export const TALK_CONFIRM = 2
/** The partner of a conversation that just closed is not offered again for this long, ms. */
export const TALK_AGAIN_MS = 2000
/** An open conversation closes once a wall has stood between the player and their partner this long, ms. */
export const TALK_WALLED_MS = 1500
/** How often the controller scans, ms (4 Hz): about as often as the engine refreshes its crowd pose copy. */
export const TALK_SCAN_MS = 250
/** A followed row that moved more than this between two scans now belongs to someone else (a respawn), m. */
export const TALK_JUMP = 4
/** Faster than this the player is offered nobody, m/s: running past someone is not stopping to talk. */
export const TALK_RUN = 2.5
/** A person's head above their feet, m: the point the on-screen test tries first. */
export const HEAD_AT = 1.7
/** A person's chest above their feet, m: the on-screen test's second try, when the screen's edge cuts the head off. */
export const CHEST_AT = 1.2
/** The label over a partner sits this far above their feet, m: over the tallest stature (look.ts, 2.05 m). */
export const LABEL_ABOVE = 2.2

/** How much of a person's distance is added at the very edge of the view (none in the middle): see talkScore. */
const EDGE_WEIGHT = 0.75

/** Where the player stands and how fast they move, as the engine reads it for a scan. Plain numbers, reused. */
export interface TalkEye {
  /** The avatar's position on the ground, m. */
  x: number
  z: number
  /** The height of the avatar's feet, m (a sky floor stands well above the street). */
  feetY: number
  /** The player's look yaw, radians, as the head rig takes it: what a bearing to the partner is measured from. */
  yaw: number
  /** The avatar's speed over the ground, m/s (compared with TALK_RUN). */
  speed: number
}

/**
 * One scan as the engine reports it: host.scan(current, out) fills a reused record. The nominee is the best-scored
 * person on screen among the nearest TALK_POOL whose speech point the camera sees unwalled, out of the best
 * TALK_WALL_CHECKS. The `cur` fields measure the row the link already follows (shown or in conversation), whether or
 * not it is the nominee; with no row followed they are as `blankScan` leaves them.
 */
export interface TalkScan {
  /** The nominee's row, or −1 for nobody. */
  best: number
  /** The nominee's talkScore (Infinity for nobody). */
  bestScore: number
  /** How far the followed row stands from the player over the ground, m (NaN when no row is followed). */
  curD: number
  /** Walls between the camera and the followed row's speech point, counted up to 2. */
  curWalls: number
  /** The followed row's talkScore, Infinity while they are off screen. */
  curScore: number
  /**
   * The followed row is nobody to talk to any more: hidden, wearing a rig, not a number, past the crowd's rows, or
   * moved more than TALK_JUMP since the last scan (someone else respawned on the row).
   */
  curGone: boolean
  /** Where the followed row stands, m (NaN when none): what the chip's and the panel's bearing are measured to. */
  curX: number
  curZ: number
}

/** Why a conversation closed. */
export type TalkEnd = 'done' | 'bye' | 'walked' | 'gone' | 'away' | 'idle' | 'sloane' | 'dispose'

/**
 * The link: nobody (`off`), someone shown with the key to press (`near`), or a conversation (`open`).
 * - `row` is the person shown or talked with.
 * - `pend` is the nominee being confirmed (−1 for none), and `pendN` how many scans in a row it has led (while
 *   someone is shown, led clearly: below TALK_SWITCH of their score).
 * - `last` is the partner of the conversation that closed last (−1 for none), and `lastAt` when it closed, in the
 *   caller's ms. An ending or a block carries no time, so `lastAt` is NaN until the next scan stamps it with its own.
 * - `walledSince` is when a wall came between the player and the partner, in the caller's ms (NaN while none is).
 */
export type TalkLink =
  | { readonly mode: 'off'; readonly pend: number; readonly pendN: number; readonly last: number; readonly lastAt: number }
  | { readonly mode: 'near'; readonly row: number; readonly pend: number; readonly pendN: number; readonly last: number; readonly lastAt: number }
  | { readonly mode: 'open'; readonly row: number; readonly walledSince: number }

/**
 * What can happen to the link.
 * - `blocked`: talking is not possible now (driving, a card or the console open, the HUD hidden, the engine halted).
 * - `scan`: a fresh TalkScan (linkStep keeps nothing of it, so the caller may reuse it). `idle` is true when nothing
 *   is in progress (no reply asked for, no voice speaking, an empty draft, the field not focused); `running` is true
 *   when the player moves faster than TALK_RUN; `now` is the caller's clock, ms.
 * - `press`: T, the pad's talk button or the chip (the controller decides what a press means while open).
 * - `end`: the conversation is closed for `why`.
 */
export type TalkEvent =
  | { readonly e: 'blocked' }
  | { readonly e: 'scan'; readonly s: Readonly<TalkScan>; readonly idle: boolean; readonly running: boolean; readonly now: number }
  | { readonly e: 'press' }
  | { readonly e: 'end'; readonly why: TalkEnd }

/** The next link, and why a conversation closed: never null when leaving `open`, and null in every other step. */
export interface TalkStep {
  readonly link: TalkLink
  readonly ended: TalkEnd | null
}

/** The link before anyone is near: nobody shown, nobody being confirmed, nobody just talked with. */
export const LINK_OFF: TalkLink = Object.freeze({ mode: 'off', pend: -1, pendN: 0, last: -1, lastAt: Number.NaN })

const NOBODY: Readonly<TalkScan> = Object.freeze({
  best: -1, bestScore: Infinity, curD: Number.NaN, curWalls: 0, curScore: Infinity, curGone: true, curX: Number.NaN, curZ: Number.NaN,
})

/** A scan with no nominee and no row followed: `out` reset in place (the engine starts each scan from it), or a new one. */
export function blankScan(out?: TalkScan): TalkScan {
  return Object.assign(out ?? {}, NOBODY)
}

/**
 * The people the player could talk to, nearest first: their rows into `rows` and their distances over the ground (m)
 * into `dists`, returning how many, at most TALK_POOL and at most either array's length. `pose` is the crowd's pose
 * copy (x, feet y, z, heading per row) and `n` the rows to consider, held to what `pose` holds. A row counts when it
 * is within TALK_REACH of the player, its feet are within TALK_FLOOR of theirs, its numbers are finite, and it is not
 * row 0 (the player's own body), not in `skip` (the fallen, who wear rigs) and not hidden (feet at or below HIDDEN_Y,
 * as contact.ts has it). Equal distances keep row order. Allocation-free: one pass over the crowd and an insertion
 * into the caller's arrays; `skip` is looked through only for a row already in reach. A player whose position is not
 * a number has nobody near.
 */
export function nearestPeople(pose: Float32Array, n: number, eye: TalkEye, skip: readonly number[], rows: Int32Array, dists: Float32Array): number {
  const cap = Math.min(TALK_POOL, rows.length, dists.length)
  const x = eye.x, z = eye.z, feet = eye.feetY
  if (!(cap > 0) || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(feet)) return 0
  const count = Math.min(Math.floor(n), Math.floor(pose.length / 4))
  const reach2 = TALK_REACH * TALK_REACH
  let found = 0
  for (let i = 1; i < count; i++) {
    const o = 4 * i
    const y = pose[o + 1]
    // Written so that a NaN fails each test: a row that is not a number is nobody.
    if (!(y > HIDDEN_Y) || !(Math.abs(y - feet) <= TALK_FLOOR)) continue
    const dx = pose[o] - x, dz = pose[o + 2] - z
    const d2 = dx * dx + dz * dz
    if (!(d2 <= reach2) || skip.includes(i)) continue
    // Held to float32 before comparing, as `dists` keeps it, so equal distances compare equal and keep row order.
    const d = Math.fround(Math.sqrt(d2))
    if (found === cap && !(d < dists[cap - 1])) continue
    let k = found < cap ? found++ : cap - 1
    while (k > 0 && dists[k - 1] > d) {
      rows[k] = rows[k - 1]
      dists[k] = dists[k - 1]
      k--
    }
    rows[k] = i
    dists[k] = d
  }
  return found
}

/**
 * How good a person is to talk to, lower better: their distance `d` (m), grown by up to three quarters the farther the
 * point the engine projected falls from the middle of the player's view. `sx` is where it falls across that view,
 * 0..1 (0.5 the middle). Someone straight ahead therefore beats someone a little closer at the screen's edge.
 * Infinity for anything that is not a number (screenPoint.ts gives NaN off screen).
 */
export function talkScore(d: number, sx: number): number {
  const score = d * (1 + EDGE_WEIGHT * Math.abs(2 * sx - 1))
  return Number.isFinite(score) ? score : Infinity
}

const off = (pend: number, pendN: number, last: number, lastAt: number): TalkLink => Object.freeze({ mode: 'off', pend, pendN, last, lastAt })
const near = (row: number, pend: number, pendN: number, last: number, lastAt: number): TalkLink => Object.freeze({ mode: 'near', row, pend, pendN, last, lastAt })
const open = (row: number, walledSince: number): TalkLink => Object.freeze({ mode: 'open', row, walledSince })

/** Leaving a conversation: off, with the partner kept as the one not to offer again (from `at`, or the next scan's time when NaN). */
const closed = (row: number, at: number, why: TalkEnd): TalkStep => ({ link: off(-1, 0, row, at), ended: why })

/**
 * The link after one event, and why a conversation closed when this step leaves `open` (null otherwise). Every
 * transition:
 * - any + blocked: off. Leaving open says 'away'.
 * - off + scan: a nominee that has led TALK_CONFIRM scans in a row is shown (near). The partner of the conversation
 *   that just closed does not count for TALK_AGAIN_MS, and nobody counts while the player runs.
 * - near + scan: the person shown stays while they are not gone, within TALK_KEEP and unwalled; when they are not,
 *   the link turns to a nominee confirmed by this scan, or off. Someone else replaces them only after leading
 *   clearly (below TALK_SWITCH of their score) for TALK_CONFIRM scans in a row.
 * - near + press: open, with the person shown. off + press and open + press change nothing (while open, the
 *   controller decides what a press means: focus the field or close).
 * - open + scan: gone closes with 'gone'; past TALK_RELEASE, or past TALK_KEEP while idle, with 'walked'; a wall for
 *   TALK_WALLED_MS, with 'walked'. Otherwise it stays, and it never changes partner.
 * - open + end: off, with that reason. near or off + end: off, with no reason (no conversation closed).
 */
export function linkStep(link: TalkLink, ev: TalkEvent): TalkStep {
  switch (ev.e) {
    case 'blocked':
    case 'end':
      if (link.mode === 'open') return closed(link.row, Number.NaN, ev.e === 'end' ? ev.why : 'away')
      return { link: off(-1, 0, link.last, link.lastAt), ended: null }
    case 'press':
      return { link: link.mode === 'near' ? open(link.row, Number.NaN) : link, ended: null }
    case 'scan':
      return link.mode === 'open' ? talking(link.row, link.walledSince, ev) : offering(link, ev)
  }
}

/** A scan while nobody is talked with: who is shown, if anyone. */
function offering(link: Exclude<TalkLink, { mode: 'open' }>, ev: Extract<TalkEvent, { e: 'scan' }>): TalkStep {
  const s = ev.s, now = ev.now
  // The last partner: stamped at the first scan after the closing (an ending carries no time), forgotten once
  // TALK_AGAIN_MS has passed.
  let last = link.last, lastAt = link.lastAt
  if (last >= 0 && Number.isNaN(lastAt)) lastAt = now
  if (last >= 0 && !(now - lastAt < TALK_AGAIN_MS)) {
    last = -1
    lastAt = Number.NaN
  }
  const shown = link.mode === 'near' ? link.row : -1
  const holds = shown >= 0 && !s.curGone && s.curD <= TALK_KEEP && !(s.curWalls >= 1)
  const best = s.best
  // While someone shown holds, a nominee counts only when it is someone else and clearly better.
  const counts = best >= 0 && best !== last && !ev.running && (!holds || (best !== shown && s.bestScore < TALK_SWITCH * s.curScore))
  const pend = counts ? best : -1
  const pendN = counts ? (best === link.pend ? link.pendN + 1 : 1) : 0
  if (pendN >= TALK_CONFIRM) return { link: near(pend, -1, 0, last, lastAt), ended: null }
  return { link: holds ? near(shown, pend, pendN, last, lastAt) : off(pend, pendN, last, lastAt), ended: null }
}

/** A scan during a conversation with `row`: it holds or it closes, and it never changes partner. */
function talking(row: number, walledSince: number, ev: Extract<TalkEvent, { e: 'scan' }>): TalkStep {
  const s = ev.s, now = ev.now
  if (s.curGone || Number.isNaN(s.curD)) return closed(row, now, 'gone')
  if (s.curD > TALK_RELEASE || (ev.idle && s.curD > TALK_KEEP)) return closed(row, now, 'walked')
  if (!(s.curWalls >= 1)) return { link: open(row, Number.NaN), ended: null }
  const since = Number.isNaN(walledSince) ? now : walledSince
  if (now - since >= TALK_WALLED_MS) return closed(row, now, 'walked')
  return { link: open(row, since), ended: null }
}
