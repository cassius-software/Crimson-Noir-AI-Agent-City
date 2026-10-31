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
import { acquireDevice, adapterLine, deviceFeatures, probeGpu, THREE_FEATURES, WebGPUUnavailableError, type GpuEntry } from './gpuDevice.ts'

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
