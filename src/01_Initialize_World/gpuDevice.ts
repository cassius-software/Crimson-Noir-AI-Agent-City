// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It asks the browser for the page's GPU device itself, before three.js is involved, so a
 * failure keeps its real cause: a page that is not a secure context, a browser without WebGPU, no adapter, an adapter
 * that only offers WebGPU's reduced compatibility level, a device the GPU refused, or one lost as it was made. Left to
 * three, every one of those became the same silent switch to WebGL2 (which cannot run the crowd's WGSL compute) and
 * one sentence that blamed the browser. The adapter asked for is a core one, as the physics worker asks
 * (physics.worker.ts), so the page and the worker agree on what a GPU is; the device asks for exactly the features
 * three asks for (THREE_FEATURES, filtered by the adapter as WebGPUBackend does), so three is handed the device it
 * would have made and keeps its core paths (it reads 'core-features-and-limits' to decide). Each failure is a
 * WebGPUUnavailableError with a code the recovery card (07_Execute_Actions/bootFailure.ts) words for the player's own
 * device. Nothing of three is imported, so the Node tests drive it with fake navigator.gpu objects
 * (gpuDevice.test.ts); the first-visit check before the onboarding (App.tsx) runs its adapter half, probeGpu.
 * What breaks if it is removed? createRenderer (world.ts) has no device to hand three, and a GPU that cannot run the
 * city is reported as a WebGL2 fallback again.
 */

/**
 * Why the page has no GPU device: the codes the recovery card words (bootFailure.ts). 'kernel-lost' and
 * 'kernel-none' are a device lost while the physics worker built a crowd kernel
 * (03_Spawn_Agents/crowdKernelMemory.ts): with a lighter kernel left for the next start, or after the lightest.
 * 'gpu-paused' is the browser handing the page no adapter because the page lost the GPU twice within two minutes
 * (bootFailure.ts gpuPaused): no adapter for now, not no adapter at all.
 */
export type GpuFailure = 'insecure' | 'no-api' | 'no-adapter' | 'compat-only' | 'device' | 'gpu-reset' | 'kernel-lost' | 'kernel-none' | 'gpu-paused'

/**
 * The page cannot have the WebGPU device the city needs; `code` says why. `background`: it happened while the page
 * was hidden (a 'gpu-reset' while the player was in another app), so the page may restart by itself once it is back.
 */
export class WebGPUUnavailableError extends Error {
  readonly code: GpuFailure
  readonly background: boolean
  constructor(code: GpuFailure, message: string, background = false) {
    super(message)
    this.name = 'WebGPUUnavailableError'
    this.code = code
    this.background = background
  }
}

/**
 * No adapter at all ('no-adapter'), with what the page's own WebGL said when asked at that moment (webgl2Answers):
 * true, WebGPU alone is held back (the browser's list of GPUs it keeps WebGPU from, a setting, Android's Advanced
 * Protection); false, the browser hands this page no GPU at all, neither WebGL2 nor WebGL (as it can after its
 * graphics crashed); null, there was nothing to ask (no canvas: a worker, the Node tests). The recovery card words
 * the two apart (bootFailure.ts).
 */
export class NoAdapterError extends WebGPUUnavailableError {
  readonly webgl: boolean | null
  constructor(message: string, webgl: boolean | null) {
    super('no-adapter', message)
    this.name = 'NoAdapterError'
    this.webgl = webgl
  }
}

/** The part of a canvas webgl2Answers asks (an HTMLCanvasElement or an OffscreenCanvas; the tests hand in fakes). */
export interface WebGL2Asked { getContext(id: 'webgl2' | 'webgl'): unknown }

/** A canvas of the page's own (a 1 by 1 OffscreenCanvas where there is no document), or null where there is none. */
function scratchCanvas(): WebGL2Asked | null {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') return document.createElement('canvas')
  return typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : null
}

/**
 * Whether the browser gives this page WebGL right now: WebGL2 asked first, then WebGL on a fresh canvas (a browser
 * can keep WebGL2 alone from a GPU on its list, and a canvas that refused one context id may not be asked another).
 * True: a context was made, and let go at once, so it holds nothing of the GPU. False: both refused. Null: no canvas
 * to ask, or asking threw. Asked only once WebGPU has offered no adapter, to tell a browser that holds back WebGPU
 * alone from one that hands the page no GPU at all.
 */
export function webgl2Answers(canvas: () => WebGL2Asked | null = scratchCanvas): boolean | null {
  try {
    for (const id of ['webgl2', 'webgl'] as const) {
      const c = canvas()
      if (!c) return null
      const gl = c.getContext(id) as { getExtension?(name: string): { loseContext?(): void } | null } | null
      if (!gl) continue
      gl.getExtension?.('WEBGL_lose_context')?.loseContext?.()
      return true
    }
    return false
  } catch {
    return null
  }
}

/** Pure. The no-adapter message, with what WebGL said where it was asked. */
export function noAdapterMessage(webgl: boolean | null): string {
  const base = 'The browser offered no WebGPU adapter (requestAdapter returned null)'
  if (webgl === null) return `${base}.`
  return webgl ? `${base}; WebGL still works on this page, so WebGPU alone is held back.` : `${base}, and refused WebGL2 and WebGL as well: it hands this page no GPU at all.`
}

/**
 * three r186's GPUFeatureName values (three/src/renderers/webgpu/utils/WebGPUConstants.js), in its order: WebGPUBackend
 * asks for each of these the adapter has. gpuDevice.test.ts holds this list equal to three's, so an upgrade that adds a
 * feature is noticed rather than quietly dropped from the device.
 */
export const THREE_FEATURES: readonly string[] = Object.freeze([
  'core-features-and-limits', 'depth-clip-control', 'depth32float-stencil8', 'texture-compression-bc', 'texture-compression-bc-sliced-3d',
  'texture-compression-etc2', 'texture-compression-astc', 'texture-compression-astc-sliced-3d', 'timestamp-query', 'indirect-first-instance',
  'shader-f16', 'rg11b10ufloat-renderable', 'bgra8unorm-storage', 'float32-filterable', 'float32-blendable', 'clip-distances',
  'dual-source-blending', 'subgroups', 'texture-formats-tier1', 'texture-formats-tier2',
])

/** The part of navigator.gpu used here (the tests hand in fakes). */
export interface GpuEntry {
  requestAdapter(options?: GPURequestAdapterOptions & { featureLevel?: 'core' | 'compatibility'; xrCompatible?: boolean }): Promise<GPUAdapter | null>
}

/** The power preference three is given too (world.ts) and the worker asks with. */
const POWER: GPUPowerPreference = 'high-performance'

/**
 * The core adapter the city needs, or the coded reason there is none: not a secure context (WebGPU is [SecureContext]
 * in every browser), no navigator.gpu, no adapter at all, or only a compatibility one (asked for only to tell those
 * two apart: its reduced limits cannot run the crowd). `origin` names the page in the insecure message. With no
 * adapter at all, `webgl` (webgl2Answers) says whether the browser still gives the page WebGL (NoAdapterError).
 */
/** The xrCompatible request: null where the browser answers none, rejects or throws on the option. */
async function xrAdapter(gpu: GpuEntry): Promise<GPUAdapter | null> {
  try {
    return await gpu.requestAdapter({ powerPreference: POWER, xrCompatible: true })
  } catch {
    return null
  }
}

export async function coreAdapter(gpu: GpuEntry | null | undefined, secure: boolean, origin = '', headset = false, webgl: () => boolean | null = webgl2Answers): Promise<GPUAdapter> {
  if (!secure) throw new WebGPUUnavailableError('insecure', `This page is not a secure context${origin ? ` (${origin})` : ''}: browsers turn WebGPU on only for https:// pages and localhost.`)
  if (!gpu) throw new WebGPUUnavailableError('no-api', 'This browser does not expose WebGPU (navigator.gpu).')
  // A headset's session binds to the page's device, and the WebXR/WebGPU binding wants an adapter asked for as
  // xrCompatible: asked that way only where a headset session is possible (xrSession.ts headsetPossible), and asked
  // again plainly should the browser answer the compatible request with none.
  const adapter = (headset ? await xrAdapter(gpu) : null) ?? (await gpu.requestAdapter({ powerPreference: POWER }))
  if (adapter) return adapter
  const compat = await gpu.requestAdapter({ powerPreference: POWER, featureLevel: 'compatibility' }).catch(() => null)
  if (compat) throw new WebGPUUnavailableError('compat-only', 'The browser offers only a WebGPU compatibility adapter; the crowd needs a core one.')
  const gl = webgl()
  throw new NoAdapterError(noAdapterMessage(gl), gl)
}

/** The features the page's device asks for: three's own list, as far as the adapter has them (WebGPUBackend's filter). */
export function deviceFeatures(adapter: Pick<GPUAdapter, 'features'>): GPUFeatureName[] {
  return THREE_FEATURES.filter((f) => adapter.features.has(f)) as GPUFeatureName[]
}

/**
 * The page's adapter and device, or a WebGPUUnavailableError: everything coreAdapter refuses, a requestDevice that
 * rejects ('device', with the browser's own words), or a device already lost when it arrives ('gpu-reset').
 * No limits are asked for, as three asked for none: the device gets the spec's defaults, which the crowd fits.
 */
export async function acquireDevice(gpu: GpuEntry | null | undefined, secure: boolean, origin = '', headset = false): Promise<{ adapter: GPUAdapter; device: GPUDevice }> {
  const adapter = await coreAdapter(gpu, secure, origin, headset)
  let device: GPUDevice
  try {
    device = await adapter.requestDevice({ requiredFeatures: deviceFeatures(adapter), label: 'page' })
  } catch (e) {
    const words = e instanceof Error && e.message ? e.message : String(e)
    // The browser's GPU process went while the device was asked for (Chrome's words for it): a reset, not a refusal.
    if (/Instance dropped|external Instance reference no longer exists/i.test(words)) throw new WebGPUUnavailableError('gpu-reset', `The GPU was lost while a device was asked for: ${words}`)
    throw new WebGPUUnavailableError('device', `The GPU refused a WebGPU device: ${words}`)
  }
  // A device lost as it was made (a GPU process that crashed in between) has settled already: the race sees it first.
  const lost = await Promise.race([device.lost, Promise.resolve(null)])
  if (lost) throw new WebGPUUnavailableError('gpu-reset', `The GPU device was lost as soon as it was made (${lost.reason}): ${lost.message || 'no message'}`)
  return { adapter, device }
}

/** How often a page that lost the GPU asks whether it is back before it starts again, ms. */
export const GPU_BACK_EVERY_MS = 500
/** How long it asks at most before it starts again regardless, ms. */
export const GPU_BACK_FOR_MS = 12_000

/**
 * Resolves true once the browser hands out a live GPU device again, false after `forMs` of asking every `everyMs`.
 * A browser whose GPU process went needs a moment to start another (measured in Chromium: a device asked for 0.4 s
 * after the crash was whole), and a page that restarted itself into that gap would get no adapter, or a device
 * already lost, and show a card for a condition about to pass. The device asked for carries no features and is
 * destroyed at once. `sleep` is the tests' clock.
 */
export async function gpuBack(gpu: GpuEntry | null | undefined, o: { everyMs?: number; forMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
  if (!gpu) return false
  const everyMs = o.everyMs ?? GPU_BACK_EVERY_MS
  const forMs = o.forMs ?? GPU_BACK_FOR_MS
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let waited = 0; ; waited += everyMs) {
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: POWER })
      const device = adapter ? await adapter.requestDevice({ label: 'page: is the GPU back' }) : null
      if (device) {
        const lost = await Promise.race([device.lost, Promise.resolve(null)])
        device.destroy()
        if (!lost) return true
      }
    } catch {
      // Not yet: a browser between GPU processes may reject the request outright.
    }
    if (waited >= forMs) return false
    await sleep(everyMs)
  }
}

/** What the adapter half says about this browser: ok, or the code and message the recovery card shows. */
export type GpuProbe = { ok: true; info: string } | { ok: false; error: WebGPUUnavailableError }

/**
 * The cheap check before a first visit's onboarding (App.tsx): coreAdapter alone, no device. The adapter is dropped;
 * the city's own request later is unaffected. Anything else thrown (a browser bug) reads as 'no-adapter'.
 */
export async function probeGpu(gpu: GpuEntry | null | undefined, secure: boolean, origin = ''): Promise<GpuProbe> {
  try {
    return { ok: true, info: adapterLine((await coreAdapter(gpu, secure, origin)).info) }
  } catch (e) {
    return { ok: false, error: e instanceof WebGPUUnavailableError ? e : new WebGPUUnavailableError('no-adapter', e instanceof Error ? e.message : String(e)) }
  }
}

/** An adapter's info as the HUD, the governor (governor.ts readDeviceHints) and bug reports read it: vendor / architecture / description. */
export function adapterLine(info: Partial<Pick<GPUAdapterInfo, 'vendor' | 'architecture' | 'description'>> | null | undefined): string {
  return info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' / ') : 'unknown adapter'
}
