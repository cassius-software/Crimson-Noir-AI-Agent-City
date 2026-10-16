// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the environment probe's schedule: the sky is baked into the scene's reflection map
 * (a PMREM) once at boot and again each time the clock has moved ENV_PROBE_STEP_HOURS, and every bake after the first
 * renders into the SAME render target. That last point is the whole reason the file exists. The old code took a fresh
 * target from the generator each time and assigned its new texture to `scene.environment`; three.js keys every
 * material's shader on the environment texture's node, so a new texture object made the renderer rebuild the node
 * graph of every material in the scene (buildings, streets, water, the fleet, fourteen thousand pedestrians) and
 * allocate a new 256² cube map and its mip chain, all on the main thread, every 12 s of real time at the default
 * `?day=24` (one game hour a minute: 0.2 h is 12 s). That is the period of the stall Julian reported. Reusing the
 * target keeps `scene.environment` the same object, so a refresh costs the generator's own passes and nothing else.
 * The schedule is pure so tests can drive it with a fake baker; `world.ts` gives it the real PMREMGenerator.
 * What breaks if it is removed? The probe either never follows the sun (reflections stuck at the boot hour) or
 * returns to re-allocating and re-keying everything on a timer.
 */

/** How far the clock moves between two bakes of the sky probe, hours (12 game minutes). */
export const ENV_PROBE_STEP_HOURS = 0.2

/** Hours apart on a 24 h clock: the shorter way round, so 23.9 and 0.1 are 0.2 apart, not 23.8. */
export function hoursApart(a: number, b: number): number {
  const d = Math.abs(a - b) % 24
  return Math.min(d, 24 - d)
}

/**
 * The probe: `refresh(hours)` bakes when the clock has moved far enough (always on the first call) and says so, so
 * the caller can point the scene at `target` once. `bake(reuse)` renders the probe: `reuse` is the target of the
 * previous bake to render into again, or null the first time (the baker allocates one); it returns the target the
 * bake landed in, which is `reuse` when one was given. `onBake` (optional) hears how long each bake took, ms.
 */
export class EnvProbe<T> {
  /** The render target the newest bake landed in; null before the first bake. */
  target: T | null = null
  /** The clock hour of the newest bake; NaN before the first. */
  bakedHours = Number.NaN
  /** How many bakes have run. */
  bakes = 0
  private readonly bake: (reuse: T | null) => T
  private readonly stepHours: number
  private readonly onBake: ((ms: number) => void) | null
  private readonly now: () => number

  constructor(
    bake: (reuse: T | null) => T,
    options: { stepHours?: number; onBake?: (ms: number) => void; now?: () => number } = {},
  ) {
    this.bake = bake
    this.stepHours = options.stepHours ?? ENV_PROBE_STEP_HOURS
    this.onBake = options.onBake ?? null
    this.now = options.now ?? (() => performance.now())
  }

  /** Whether `hours` is far enough from the newest bake for a refresh (true before the first bake). */
  due(hours: number): boolean {
    return Number.isNaN(this.bakedHours) || hoursApart(hours, this.bakedHours) > this.stepHours
  }

  /** Bakes if due; true when a bake ran this call (then `target` is current and may be a new object only the first time). */
  refresh(hours: number): boolean {
    if (!this.due(hours)) return false
    const t0 = this.now()
    const previous = this.target
    this.target = this.bake(previous)
    this.bakedHours = hours
    this.bakes++
    if (previous !== null && this.target !== previous) throw new Error('EnvProbe: the baker must render into the target it was given')
    this.onBake?.(this.now() - t0)
    return true
  }
}
