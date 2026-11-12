// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins how a lost device is told from a refusal (gpuPipelines.ts), with the words Chrome
 * gives each. Measured in Chromium with its GPU process killed while a worker compiled: both devices' `lost` settle
 * (reason 'unknown', "A valid external Instance reference no longer exists."), the pending
 * createComputePipelineAsync rejects as a GPUPipelineError of reason 'internal' with those same words, and
 * popErrorScope rejects with "Instance dropped in popErrorScope", the line a phone's card showed. Read as refusals, the
 * crowd's ladder ran every kernel down the dead device and blamed the compiler. The crowd's own ladder over these is
 * pinned in 03_Spawn_Agents/crowdCompute.test.ts.
 * What breaks if it is removed? A change that reads a loss as a compiler's refusal again passes every other test.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compilePasses, DeviceLostError, lossOf, LOSS_GRACE_MS, processGone, saysLost, ShaderRefusedError, withErrorScopes, type PipelineDevice, type ScopedDevice } from './gpuPipelines.ts'

const GONE = 'A valid external Instance reference no longer exists.'
type Loss = { reason: string; message: string }

/** A device whose passes are refused as `refuse` says, and whose `lost` settles when lose() is called. */
function device(refuse: (entry: string) => { reason?: string; message: string } | null = () => null) {
  let lose: (info: Loss) => void = () => {}
  const lost = new Promise<Loss>((resolve) => { lose = resolve })
  const asked: string[] = []
  const d = {
    lost,
    lose,
    asked,
    createShaderModule: (m: { code: string }) => ({ code: m.code, getCompilationInfo: () => Promise.resolve({ messages: [] }) }) as unknown as GPUShaderModule,
    createComputePipelineAsync: (p: { compute: { entryPoint: string } }) => {
      asked.push(p.compute.entryPoint)
      const r = refuse(p.compute.entryPoint)
      return r ? Promise.reject(Object.assign(new Error(r.message), { name: 'GPUPipelineError', reason: r.reason })) : Promise.resolve({ entryPoint: p.compute.entryPoint } as unknown as GPUComputePipeline)
    },
  }
  return d satisfies PipelineDevice
}

test('lossOf: a settled loss wins at once, a live device answers null after the wait, and a device that cannot say is never lost', async () => {
  const d = device()
  const t0 = performance.now()
  assert.equal(await lossOf(d), null, 'not lost: nothing, without waiting')
  assert.ok(performance.now() - t0 < 100)
  d.lose({ reason: 'unknown', message: GONE })
  assert.deepEqual(await lossOf(d), { reason: 'unknown', message: GONE })
  // A loss that settles inside the wait is seen; the wait itself ends with the loss, not the timer.
  const late = device()
  setTimeout(() => late.lose({ reason: 'destroyed', message: '' }), 10)
  const t1 = performance.now()
  assert.deepEqual(await lossOf(late, 5000), { reason: 'destroyed', message: '' })
  assert.ok(performance.now() - t1 < 2000, 'the wait ends when the device says it is lost')
  assert.equal(await lossOf({}), null, 'a mock with no `lost`')
  assert.deepEqual(await lossOf({ lost: Promise.resolve({}) }), { reason: 'unknown', message: '' }, 'a loss that says nothing of itself is still a loss')
})

test('compilePasses: a pass refused on a live device is a refusal; on a lost device, or in the words of a dropped GPU process, a DeviceLostError that names the module', async () => {
  // Live: the driver's refusal, as before.
  const live = device((entry) => (entry === 'simulate' ? { reason: 'internal', message: 'CreateComputePipelines failed with VK_ERROR_INITIALIZATION_FAILED' } : null))
  const refused = await compilePasses(live, 'crowd.wgsl', 'code', ['spawn', 'simulate']).then(() => null, (e: unknown) => e)
  assert.ok(refused instanceof ShaderRefusedError)
  assert.equal(refused.reason, 'internal')
  assert.equal(refused.entryPoint, 'simulate')
  // Lost under the compile: Chrome rejects what was pending as internal, in the loss's own words. Not a refusal.
  const dead = device(() => ({ reason: 'internal', message: GONE }))
  dead.lose({ reason: 'unknown', message: GONE })
  const lost = await compilePasses(dead, 'crowd.wgsl', 'code', ['spawn', 'simulate']).then(() => null, (e: unknown) => e)
  assert.ok(lost instanceof DeviceLostError, 'a lost device is not a refusal')
  assert.equal(lost.message, `GPU device lost (unknown) while compiling crowd.wgsl: ${GONE}`)
  assert.equal(lost.during, 'compiling crowd.wgsl')
  assert.equal(lost.reason, 'unknown')
  assert.equal(lost.detail, GONE)
  // The loss told late (inside the wait): still the loss, with the device's own reason.
  const slow = device(() => ({ reason: 'internal', message: 'the driver stopped' }))
  setTimeout(() => slow.lose({ reason: 'unknown', message: 'GPU connection lost' }), LOSS_GRACE_MS / 5)
  const late = await compilePasses(slow, 'crowd.wgsl (light kernel)', 'code', ['simulate']).then(() => null, (e: unknown) => e)
  assert.ok(late instanceof DeviceLostError)
  assert.equal(late.message, 'GPU device lost (unknown) while compiling crowd.wgsl (light kernel): GPU connection lost')
  // The words alone (a browser that never settles `lost`, a mock that has none): Chrome's for a dropped GPU process.
  for (const words of [GONE, 'Instance dropped in createComputePipelineAsync']) {
    const mute = { ...device(() => ({ reason: 'internal', message: words })), lost: undefined }
    const e = await compilePasses(mute, 'crowd.wgsl', 'code', ['simulate']).then(() => null, (x: unknown) => x)
    assert.ok(e instanceof DeviceLostError, words)
    assert.equal(e.message, `GPU device lost (unknown) while compiling crowd.wgsl: ${words}`)
  }
  // The backend's own words for a device it lost: Dawn rejects the pipeline as internal and never tells the WebGPU
  // device (its `lost` stays pending), so the words are the only sign. A loss of that device, not of the GPU process.
  for (const words of ['CreateComputePipelines failed with VK_ERROR_DEVICE_LOST', 'D3D12 create compute pipeline failed with DXGI_ERROR_DEVICE_REMOVED (0x887A0005)', 'DXGI_ERROR_DEVICE_HUNG', 'DXGI_ERROR_DEVICE_RESET']) {
    const e = await compilePasses(device(() => ({ reason: 'internal', message: words })), 'crowd.wgsl', 'code', ['simulate']).then(() => null, (x: unknown) => x)
    assert.ok(e instanceof DeviceLostError, words)
    assert.equal(saysLost(words), true)
    assert.equal(processGone(words), false, 'that device alone')
  }
  assert.equal(processGone(GONE), true)
  assert.equal(processGone('Instance dropped in popErrorScope'), true)
  assert.equal(saysLost(GONE), true)
  for (const words of ['CreateComputePipelines failed with VK_ERROR_INITIALIZATION_FAILED', 'VK_ERROR_OUT_OF_DEVICE_MEMORY', '']) assert.equal(saysLost(words), false, words)
  // A compile that outlived its device rejects nothing (WebGPU resolves a lost device's pipelines): the device is asked.
  const quiet = device()
  quiet.lose({ reason: 'unknown', message: 'the driver reset the device' })
  const after = await compilePasses(quiet, 'crowd.wgsl', 'code', ['spawn', 'simulate']).then(() => null, (e: unknown) => e)
  assert.ok(after instanceof DeviceLostError)
  assert.equal(after.message, 'GPU device lost (unknown) while compiling crowd.wgsl: the driver reset the device')
  // A live device whose passes compiled: the pipelines, all of them.
  const fine = device()
  const built = await compilePasses(fine, 'crowd.wgsl', 'code', ['spawn', 'simulate'])
  assert.deepEqual([...built.pipelines.keys()], ['spawn', 'simulate'])
})

/** A device with a scope stack: popErrorScope answers `errors[filter]`, or rejects with `reject` once set. */
function scoped(errors: Partial<Record<GPUErrorFilter, string>> = {}) {
  let lose: (info: Loss) => void = () => {}
  const lost = new Promise<Loss>((resolve) => { lose = resolve })
  const stack: GPUErrorFilter[] = []
  const d = {
    lost,
    lose,
    stack,
    reject: null as string | null,
    pushErrorScope(filter: GPUErrorFilter) { stack.push(filter) },
    popErrorScope(): Promise<GPUError | null> {
      const filter = stack.pop()
      assert.ok(filter, 'a pop with no scope pushed')
      if (d.reject) return Promise.reject(Object.assign(new Error(d.reject), { name: 'OperationError' }))
      const message = errors[filter]
      return Promise.resolve(message ? ({ message } as GPUError) : null)
    },
  }
  return d satisfies ScopedDevice
}

test('withErrorScopes: a build that throws leaves the device no scope behind, and its own error is what is thrown', async () => {
  const d = scoped()
  const thrown = await withErrorScopes(d, () => { throw new Error('the build itself failed') }).then(() => null, (e: unknown) => e)
  assert.ok(thrown instanceof Error && thrown.message === 'the build itself failed')
  assert.equal(d.stack.length, 0, 'every scope pushed was popped')
  // Even where the pops reject (the device went too): the build's error, no scope left.
  const gone = scoped()
  gone.reject = 'Instance dropped in popErrorScope'
  const still = await withErrorScopes(gone, () => { throw new Error('first') }).then(() => null, (e: unknown) => e)
  assert.ok(still instanceof Error && still.message === 'first')
  assert.equal(gone.stack.length, 0)
})

test('withErrorScopes: a pop that rejects, or a device that says it is lost once the scopes are popped, is a DeviceLostError naming what was being built', async () => {
  // A live device: the value and each scope's first error, as before.
  const live = scoped({ 'out-of-memory': 'no memory for the grid' })
  assert.deepEqual(await withErrorScopes(live, () => 7), { value: 7, errors: [{ filter: 'out-of-memory', message: 'no memory for the grid' }] })
  assert.equal(live.stack.length, 0)
  // The GPU process gone: popErrorScope rejects, in the words the phone's card showed. The device's own words win when
  // it has said it is lost; the pop's are kept when it has not.
  const dropped = scoped()
  dropped.reject = 'Instance dropped in popErrorScope'
  dropped.lose({ reason: 'unknown', message: GONE })
  const a = await withErrorScopes(dropped, () => 1, 'setting up the full kernel').then(() => null, (e: unknown) => e)
  assert.ok(a instanceof DeviceLostError)
  assert.equal(a.message, `GPU device lost (unknown) while setting up the full kernel: ${GONE}`)
  const mute = scoped()
  mute.reject = 'Instance dropped in popErrorScope'
  const b = await withErrorScopes(mute, () => 1).then(() => null, (e: unknown) => e)
  assert.ok(b instanceof DeviceLostError)
  assert.equal(b.message, 'GPU device lost (unknown) while building on the GPU: Instance dropped in popErrorScope')
  // A lost device whose pops resolve (the specification's way: a lost device's scopes capture nothing): not a build that
  // went well.
  const quiet = scoped()
  quiet.lose({ reason: 'unknown', message: 'driver reset' })
  const c = await withErrorScopes(quiet, () => 1, 'building the flow field').then(() => null, (e: unknown) => e)
  assert.ok(c instanceof DeviceLostError)
  assert.equal(c.message, 'GPU device lost (unknown) while building the flow field: driver reset')
  assert.equal(quiet.stack.length, 0, 'every scope was popped first')
})
