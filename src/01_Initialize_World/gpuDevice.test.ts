// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins gpuDevice.ts, the page's own request for its GPU device, against fake navigator.gpu
 * objects: an insecure page, a browser without WebGPU, no adapter, only a compatibility adapter, a device the GPU
 * refuses and one lost as it is made each give their own code; a working adapter gives a device asked for with three's
 * own feature list filtered by the adapter (so three keeps its core paths on a core device), the same power preference
 * and no featureLevel (core, as the physics worker asks). createRenderer's wiring (world.ts) is read as text: the device
 * goes to three, which then makes no request and no WebGL2 fallback of its own.
 * What breaks if it is removed? The page could drift back to three's compatibility-level request, ask for a feature list
 * that flips three into compatibility mode, or lose the real cause of a failure, with nothing to say so.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { acquireDevice, adapterLine, coreAdapter, deviceFeatures, GPU_BACK_EVERY_MS, GPU_BACK_FOR_MS, gpuBack, NoAdapterError, noAdapterMessage, probeGpu, THREE_FEATURES, webgl2Answers, WebGPUUnavailableError, type GpuEntry, type WebGL2Asked } from './gpuDevice.ts'

// three's constants module is plain JavaScript; a computed specifier keeps the page's typecheck off it.
const CONSTANTS: string = 'three/src/renderers/webgpu/utils/WebGPUConstants.js'
const { GPUFeatureName } = (await import(CONSTANTS)) as { GPUFeatureName: Record<string, string> }

interface Asked { adapter: unknown[]; device: unknown[] }

/** A fake device: `lost` settles with `lostWith` at once, else never. */
function fakeDevice(lostWith: { reason: string; message: string } | null = null) {
  return { lost: lostWith ? Promise.resolve(lostWith) : new Promise<never>(() => {}), destroy() {} } as unknown as GPUDevice
}

/** A fake navigator.gpu: `core` and `compat` are what each kind of request returns; the device request may refuse. */
function fakeGpu(o: { core: boolean; compat?: boolean; features?: string[]; refuse?: string; lost?: { reason: string; message: string } }) {
  const asked: Asked = { adapter: [], device: [] }
  const adapter = {
    features: new Set(o.features ?? ['core-features-and-limits', 'timestamp-query', 'float32-filterable', 'not-a-three-feature']),
    info: { vendor: 'acme', architecture: 'rdna-3', description: '' },
    requestDevice: async (d: unknown) => {
      asked.device.push(d)
      if (o.refuse) throw new DOMException(o.refuse, 'OperationError')
      return fakeDevice(o.lost ?? null)
    },
  }
  const gpu: GpuEntry = {
    requestAdapter: async (opts) => {
      asked.adapter.push(opts)
      const compat = (opts as { featureLevel?: string } | undefined)?.featureLevel === 'compatibility'
      return ((compat ? o.compat : o.core) ? adapter : null) as GPUAdapter | null
    },
  }
  return { gpu, asked, adapter }
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p } catch (e) { assert.ok(e instanceof WebGPUUnavailableError, String(e)); return e.code }
  return 'resolved'
}

test('THREE_FEATURES is three r186\'s GPUFeatureName list, in its order', () => {
  assert.deepEqual([...THREE_FEATURES], Object.values(GPUFeatureName))
})

test('a working core adapter: one core request (no featureLevel), the device asks for three\'s features the adapter has', async () => {
  const { gpu, asked, adapter } = fakeGpu({ core: true })
  const got = await acquireDevice(gpu, true)
  assert.equal(got.adapter, adapter as unknown as GPUAdapter)
  assert.deepEqual(asked.adapter, [{ powerPreference: 'high-performance' }], 'core, as physics.worker.ts asks, and nothing else asked')
  assert.equal(asked.device.length, 1)
  const d = asked.device[0] as { requiredFeatures: string[]; requiredLimits?: unknown }
  assert.deepEqual(d.requiredFeatures, ['core-features-and-limits', 'timestamp-query', 'float32-filterable'], 'three\'s filter: its own names the adapter has')
  assert.ok(d.requiredFeatures.includes('core-features-and-limits'), 'so three keeps compatibilityMode false on a core device')
  assert.equal(d.requiredLimits, undefined, 'no limits, as three asked none: the spec defaults')
  assert.deepEqual(deviceFeatures({ features: new Set<string>() } as unknown as GPUAdapter), [])
})

test('every failure has its own code', async () => {
  assert.equal(await codeOf(acquireDevice(fakeGpu({ core: true }).gpu, false, 'http://lan.test:8080')), 'insecure', 'checked before anything is asked')
  assert.equal(await codeOf(acquireDevice(undefined, true)), 'no-api')
  assert.equal(await codeOf(acquireDevice(fakeGpu({ core: false }).gpu, true)), 'no-adapter')
  assert.equal(await codeOf(acquireDevice(fakeGpu({ core: false, compat: true }).gpu, true)), 'compat-only')
  assert.equal(await codeOf(acquireDevice(fakeGpu({ core: true, refuse: 'GPU process is busy' }).gpu, true)), 'device')
  // Chrome's words for a request whose GPU process went meanwhile: a reset, not a GPU that refuses devices.
  assert.equal(await codeOf(acquireDevice(fakeGpu({ core: true, refuse: 'A valid external Instance reference no longer exists.' }).gpu, true)), 'gpu-reset')
  assert.equal(await codeOf(acquireDevice(fakeGpu({ core: true, lost: { reason: 'unknown', message: 'GPU process crashed' } }).gpu, true)), 'gpu-reset')
})

test('the messages keep the cause: the origin, today\'s no-API sentence, the browser\'s refusal, the loss', async () => {
  const msg = async (p: Promise<unknown>) => { try { await p; return '' } catch (e) { return (e as Error).message } }
  assert.match(await msg(acquireDevice(fakeGpu({ core: true }).gpu, false, 'http://lan.test:8080')), /http:\/\/lan\.test:8080.*https:\/\/ pages and localhost/)
  assert.equal(await msg(acquireDevice(null, true)), 'This browser does not expose WebGPU (navigator.gpu).')
  assert.match(await msg(acquireDevice(fakeGpu({ core: true, refuse: 'GPU process is busy' }).gpu, true)), /GPU process is busy/)
  assert.match(await msg(acquireDevice(fakeGpu({ core: true, lost: { reason: 'unknown', message: 'GPU process crashed' } }).gpu, true)), /\(unknown\): GPU process crashed/)
})

test('the compatibility probe only tells compat-only from no adapter: it never becomes the device', async () => {
  const { gpu, asked } = fakeGpu({ core: false, compat: true })
  await codeOf(acquireDevice(gpu, true))
  assert.deepEqual(asked.adapter, [{ powerPreference: 'high-performance' }, { powerPreference: 'high-performance', featureLevel: 'compatibility' }])
  assert.equal(asked.device.length, 0)
})

test('probeGpu: the adapter half alone, never a device; any failure comes back coded', async () => {
  const ok = fakeGpu({ core: true })
  assert.deepEqual(await probeGpu(ok.gpu, true), { ok: true, info: 'acme / rdna-3' })
  assert.equal(ok.asked.device.length, 0)
  for (const [gpu, secure, code] of [[undefined, true, 'no-api'], [fakeGpu({ core: false }).gpu, true, 'no-adapter'], [fakeGpu({ core: true }).gpu, false, 'insecure']] as const) {
    const r = await probeGpu(gpu, secure)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.code, code)
  }
  const odd: GpuEntry = { requestAdapter: () => Promise.reject(new TypeError('odd browser')) }
  const r = await probeGpu(odd, true)
  assert.ok(!r.ok && r.error.code === 'no-adapter' && /odd browser/.test(r.error.message))
})

test('no adapter: the page\'s own WebGL2 is asked once, and its answer travels with the failure', async () => {
  // A context made is let go at once; a refusal is false; no canvas, or a canvas that throws, is unknown.
  let lost = 0
  const made: WebGL2Asked = { getContext: () => ({ getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext: () => { lost++ } } : null) }) }
  assert.equal(webgl2Answers(() => made), true)
  assert.equal(lost, 1, 'the context is let go at once')
  assert.equal(webgl2Answers(() => ({ getContext: () => ({}) })), true, 'a context without the extension still answers')
  // WebGL2 refused, WebGL given (a browser that keeps WebGL2 alone from a GPU): still true, asked on a fresh canvas.
  let canvases = 0
  const asked: string[] = []
  assert.equal(webgl2Answers(() => { canvases++; return { getContext: (id: string) => { asked.push(id); return id === 'webgl' ? {} : null } } }), true)
  assert.deepEqual(asked, ['webgl2', 'webgl'])
  assert.equal(canvases, 2, 'each context id on a canvas of its own')
  // Both refused: false.
  assert.equal(webgl2Answers(() => ({ getContext: () => null })), false)
  assert.equal(webgl2Answers(() => null), null)
  assert.equal(webgl2Answers(() => { throw new Error('no canvas here') }), null)
  assert.equal(webgl2Answers(() => ({ getContext: () => { throw new Error('blocked') } })), null)
  assert.equal(webgl2Answers(), null, 'Node has no canvas: nothing to ask')
  // Each answer in the message, and on the error, where the card reads it.
  for (const gl of [true, false, null] as const) {
    let asked = 0
    const e = await coreAdapter(fakeGpu({ core: false }).gpu, true, '', false, () => { asked++; return gl }).then(() => null, (x: unknown) => x)
    assert.ok(e instanceof NoAdapterError && e instanceof WebGPUUnavailableError, String(gl))
    assert.equal(e.code, 'no-adapter')
    assert.equal(e.webgl, gl)
    assert.equal(e.message, noAdapterMessage(gl))
    assert.equal(asked, 1)
  }
  assert.equal(noAdapterMessage(null), 'The browser offered no WebGPU adapter (requestAdapter returned null).')
  assert.match(noAdapterMessage(true), /; WebGL still works on this page, so WebGPU alone is held back\.$/)
  assert.match(noAdapterMessage(false), /, and refused WebGL2 and WebGL as well: it hands this page no GPU at all\.$/)
  // An adapter, or only a compatibility one, never asks WebGL2.
  let never = 0
  await coreAdapter(fakeGpu({ core: true }).gpu, true, '', false, () => { never++; return true })
  await coreAdapter(fakeGpu({ core: false, compat: true }).gpu, true, '', false, () => { never++; return true }).catch(() => {})
  assert.equal(never, 0)
})

test('adapterLine: the profile\'s string, as createRenderer always built it', () => {
  assert.equal(adapterLine({ vendor: 'google', architecture: 'swiftshader', description: '' }), 'google / swiftshader')
  assert.equal(adapterLine(undefined), 'unknown adapter')
})

test('createRenderer hands three the page\'s device, checks the backend, and releases the device itself', () => {
  const world = readFileSync(new URL('./world.ts', import.meta.url), 'utf8')
  const body = world.slice(world.indexOf('export async function createRenderer'), world.indexOf('/** The GPUBuffer three created'))
  assert.match(body, /const headset = await headsetPossible\(navigator\)/, 'the headset probe runs first (xrSystem.ts), never throwing')
  assert.match(body, /const \{ adapter, device \} = await acquireDevice\(navigator\.gpu, window\.isSecureContext !== false, window\.location\.origin, headset\)/)
  assert.ok(body.indexOf('acquireDevice(') < body.indexOf('new WebGPURenderer('), 'the device exists before three')
  assert.match(body, /new WebGPURenderer\(\{[^}]*reversedDepthBuffer: true, device \}\)/)
  assert.match(body, /if \(!backend\.isWebGPUBackend \|\| !backend\.device\)/, 'the WebGL2 guard stays')
  assert.match(body, /export function releaseGpu[\s\S]*gpu\.device\.destroy\(\)/, 'three destroys only a device it made: the page destroys its own')
  assert.doesNotMatch(readFileSync(new URL('./gpuDevice.ts', import.meta.url), 'utf8'), /from 'three/, 'gpuDevice.ts imports nothing of three')
})

test('a headset possible: the adapter is asked for as xrCompatible first, and plainly when that request answers none or throws; without a headset nothing xr is asked', async () => {
  const a = fakeGpu({ core: true })
  await acquireDevice(a.gpu, true, '', true)
  assert.deepEqual(a.asked.adapter, [{ powerPreference: 'high-performance', xrCompatible: true }])
  const b = fakeGpu({ core: true })
  await acquireDevice(b.gpu, true, '', false)
  assert.deepEqual(b.asked.adapter, [{ powerPreference: 'high-performance' }])
  const c = fakeGpu({ core: true })
  await acquireDevice(c.gpu, true)
  assert.deepEqual(c.asked.adapter, [{ powerPreference: 'high-performance' }], 'the default is no headset')
  // The compatible request refused (null): the plain one follows and the device is made.
  const d = fakeGpu({ core: true })
  const asked: unknown[] = []
  const refusing: GpuEntry = { requestAdapter: async (opts) => { asked.push(opts); return (opts as { xrCompatible?: boolean } | undefined)?.xrCompatible ? null : d.gpu.requestAdapter(opts) } }
  const got = await acquireDevice(refusing, true, '', true)
  assert.ok(got.device)
  assert.deepEqual(asked, [{ powerPreference: 'high-performance', xrCompatible: true }, { powerPreference: 'high-performance' }])
  // A browser that throws on the option: the same.
  const thrown: unknown[] = []
  const throwing: GpuEntry = { requestAdapter: (opts) => { thrown.push(opts); if ((opts as { xrCompatible?: boolean } | undefined)?.xrCompatible) throw new TypeError('unknown option'); return d.gpu.requestAdapter(opts) } }
  assert.ok((await acquireDevice(throwing, true, '', true)).device)
  assert.deepEqual(thrown, [{ powerPreference: 'high-performance', xrCompatible: true }, { powerPreference: 'high-performance' }])
  // No adapter either way is still 'no-adapter' (the compatibility probe after).
  const none = fakeGpu({ core: false })
  assert.equal(await codeOf(acquireDevice(none.gpu, true, '', true)), 'no-adapter')
  assert.deepEqual(none.asked.adapter.map((o) => (o as { xrCompatible?: boolean; featureLevel?: string }).xrCompatible ?? (o as { featureLevel?: string }).featureLevel ?? 'plain'), [true, 'plain', 'compatibility'])
})

test('gpuBack: asks until the browser hands out a live device again, every half second for twelve at most; the device asked for is destroyed', async () => {
  assert.equal(GPU_BACK_EVERY_MS, 500)
  assert.equal(GPU_BACK_FOR_MS, 12_000)
  const slept: number[] = []
  const sleep = async (ms: number): Promise<void> => { slept.push(ms) }
  // Whole at once: nothing is waited for, and the device is let go.
  let destroyed = 0
  const live = (): GPUDevice => ({ lost: new Promise<never>(() => {}), destroy() { destroyed++ } }) as unknown as GPUDevice
  const dead = (): GPUDevice => ({ lost: Promise.resolve({ reason: 'unknown', message: 'A valid external Instance reference no longer exists.' }), destroy() { destroyed++ } }) as unknown as GPUDevice
  const whole: GpuEntry = { requestAdapter: async () => ({ requestDevice: async () => live() }) as unknown as GPUAdapter }
  assert.equal(await gpuBack(whole, { sleep }), true)
  assert.deepEqual(slept, [])
  assert.equal(destroyed, 1)
  // A browser between GPU processes: the request rejected, then no adapter, then a device born lost, then a whole one.
  let n = 0
  const asked: unknown[] = []
  const coming: GpuEntry = {
    requestAdapter: async (opts) => {
      asked.push(opts)
      n++
      if (n === 1) throw new DOMException('GPU process is gone', 'OperationError')
      if (n === 2) return null
      return { requestDevice: async () => (n === 3 ? dead() : live()) } as unknown as GPUAdapter
    },
  }
  destroyed = 0
  assert.equal(await gpuBack(coming, { sleep }), true)
  assert.deepEqual(slept, [500, 500, 500])
  assert.equal(n, 4)
  assert.equal(destroyed, 2, 'the lost device and the whole one')
  assert.deepEqual(asked[0], { powerPreference: 'high-performance' })
  // Never back: it gives up after the budget, having asked once more at the end.
  slept.length = 0
  let never = 0
  const gone: GpuEntry = { requestAdapter: async () => { never++; return null } }
  assert.equal(await gpuBack(gone, { sleep }), false)
  assert.equal(slept.length, 24)
  assert.equal(never, 25)
  assert.equal(await gpuBack(gone, { sleep, everyMs: 100, forMs: 250 }), false)
  // No WebGPU at all: nothing to wait for.
  assert.equal(await gpuBack(undefined, { sleep }), false)
})
