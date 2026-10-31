// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It answers one question before anything is built: can this browser show the city in a
 * headset at all? WebXR (navigator.xr), the WebXR/WebGPU binding (XRGPUBinding, which three's XRManager needs for a
 * WebGPU renderer) and an immersive mode the browser says it supports. The GPU adapter is asked for as xrCompatible
 * only when the answer is yes (01_Initialize_World/gpuDevice.ts), and the session itself lives in
 * 07_Execute_Actions/xrSession.ts. Pure: no three, no DOM beyond the navigator it is handed.
 * What breaks if it is removed? The adapter is never asked for as a headset's, and the session has no gate.
 */

import type { XrSystemLike } from './web-hardware.d.ts'

/** Where the headset stands: no WebXR or binding here, off, asked for, or showing the city in VR or passthrough. */
export type XrState = 'unsupported' | 'off' | 'entering' | 'vr' | 'ar'

/** The browser binds WebXR to WebGPU (three's own test: XRManager reads the same global). */
export function hasWebGpuBinding(g: object = globalThis): boolean {
  return typeof (g as { XRGPUBinding?: unknown }).XRGPUBinding !== 'undefined'
}

/** The slice of a browser's navigator.xr, or null where there is none (nearly every desktop and phone browser). */
export function xrSystemOf(nav: object | null | undefined): XrSystemLike | null {
  const xr = (nav as { xr?: unknown } | null | undefined)?.xr
  if (typeof xr !== 'object' || xr === null) return null
  const s = xr as { isSessionSupported?: unknown; requestSession?: unknown }
  return typeof s.isSessionSupported === 'function' && typeof s.requestSession === 'function' ? (xr as XrSystemLike) : null
}

/** Which immersive modes a browser's XR system says it supports, the binding taken for granted: false where it throws or rejects. */
export async function sessionModes(xr: XrSystemLike): Promise<{ vr: boolean; ar: boolean }> {
  const ask = (mode: 'immersive-vr' | 'immersive-ar') => {
    try { return xr.isSessionSupported(mode).then((v) => v === true, () => false) } catch { return Promise.resolve(false) }
  }
  const [vr, ar] = await Promise.all([ask('immersive-vr'), ask('immersive-ar')])
  return { vr, ar }
}

/** The modes the page may ask for: none without WebXR or the WebGPU binding (on `g`), else what the system says. */
export async function immersiveModes(xr: XrSystemLike | null, g: object = globalThis): Promise<{ vr: boolean; ar: boolean }> {
  if (!xr || !hasWebGpuBinding(g)) return { vr: false, ar: false }
  return sessionModes(xr)
}

/** A headset session could be asked for: WebXR, the binding and at least one immersive mode. Never throws. */
export async function headsetPossible(nav: object | null | undefined, g: object = globalThis): Promise<boolean> {
  const m = await immersiveModes(xrSystemOf(nav), g)
  return m.vr || m.ar
}
