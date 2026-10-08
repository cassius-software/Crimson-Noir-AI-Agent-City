// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The page's half of a Ring-0 kernel panic: the audit itself runs in the physics
 * worker (ring0.ts via simCore.ts); when it halts the simulation, the page logs the fatal line, severs the
 * hardware bridge and throws SYSTEM LOCKED out of the frame. Kept apart from ring0.ts so the page's bundle
 * carries this function and not the auditor.
 * What breaks if it is removed? A panic in the physics realm would not lock the page or cut the hardware.
 */

/**
 * Frozen. Logs `[RING-0 FATAL] <reason>`, runs `sever()` (a failing sever is logged and must not stop the
 * halt), then throws `Error('SYSTEM LOCKED: <reason>')`. Never returns.
 */
export function kernelPanic(reason: string, sever: () => void): never {
  console.error(`[RING-0 FATAL] ${reason}`)
  try {
    sever()
  } catch (e) {
    console.error('[RING-0 FATAL] severing the hardware bridge failed:', e)
  }
  throw new Error(`SYSTEM LOCKED: ${reason}`)
}

Object.freeze(kernelPanic)
