/**
 * Why does this file exist? It is a script's walk (SimControls.avatar.walk, which the spatial harness drives) as plain
 * arithmetic, so it can be proved in Node against the physics realm itself (simCore.test.ts): what a request holds (a
 * velocity, for so long), what it overrides (the player's own keys and stick, on foot, only while it lasts) and what it
 * cannot do (walk faster than a run: the realm caps any foot velocity the page sends).
 * What breaks if it is removed? The engine has no rule for a script's walk, and the harness cannot move the avatar.
 */

/** Longest a script's walk runs on one call, ms: a script that ends mid-walk stops soon. */
export const MAX_WALK_MS = 10_000
/** How long a walk runs when the call gives no time, ms. */
export const DEFAULT_WALK_MS = 1000

/** A script's walk: the velocity it asks for (m/s along world x and z), until `until` (the frame clock, ms). */
export interface ScriptedWalk {
  x: number
  z: number
  until: number
}

/**
 * Takes a script's request at `now` into `w`: the velocity (vx, vz) held for `ms` (DEFAULT_WALK_MS when not given,
 * clamped to 0…MAX_WALK_MS, none when not finite); (0, 0) ends the walk at once. A velocity that is not finite is no
 * request: `w` is left as it was. Returns whether the request was taken.
 */
export function requestWalk(w: ScriptedWalk, now: number, vx: number, vz: number, ms?: number): boolean {
  if (!Number.isFinite(vx) || !Number.isFinite(vz)) return false
  const hold = ms === undefined ? DEFAULT_WALK_MS : Number.isFinite(ms) ? Math.min(MAX_WALK_MS, Math.max(0, ms)) : 0
  w.x = vx
  w.z = vz
  w.until = vx === 0 && vz === 0 ? 0 : now + hold
  return true
}

/**
 * Overrides this frame's foot velocity (the player's own, from the keys and stick) with the script's while its walk
 * lasts; the engine asks only on foot. Returns whether it did.
 */
export function applyWalk(w: Readonly<ScriptedWalk>, now: number, foot: { x: number; z: number }): boolean {
  if (!(now < w.until)) return false
  foot.x = w.x
  foot.z = w.z
  return true
}
