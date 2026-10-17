// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins world.ts tolerateIdentitySwizzle, which lets the city run on Chromium builds whose
 * WebGPU still typed GPUTextureViewDescriptor.swizzle as a dictionary: three r186 sends the string 'rgba' on every view,
 * and such a browser throws a TypeError on the first view the city draws into. The fake prototype below throws exactly
 * that way; the identity is dropped before the call, any other value passes through, and patching twice wraps once.
 * The browser smoke test (tools/browser/smoke.mjs) runs the real thing on Chromium 141.
 * What breaks if it is removed? A later edit could drop the call from createRenderer, or widen it to rewrite swizzles
 * that are not the identity, with nothing in the Node suite to say so.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Vite's `?raw` import, for Node (crowdCompute.test.ts's hook): world.ts's imports reach the crowd's WGSL that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { tolerateIdentitySwizzle } = await import('./world.ts')

/** A GPUTexture prototype of a browser that wants the old dictionary: any string swizzle is a TypeError. */
function oldChromium() {
  const seen: unknown[] = []
  const proto = {
    createView(d?: { swizzle?: unknown }) {
      if (d && typeof d.swizzle === 'string') throw new TypeError("Failed to read the 'swizzle' property from 'GPUTextureViewDescriptor': The provided value is not of type 'GPUTextureComponentSwizzle'.")
      seen.push(d?.swizzle)
      return { view: true }
    },
  }
  return { proto, seen }
}

test('three\'s identity swizzle throws on the old typing, and is dropped once tolerated', () => {
  const { proto, seen } = oldChromium()
  assert.throws(() => proto.createView({ swizzle: 'rgba' }), TypeError)
  tolerateIdentitySwizzle(proto)
  assert.deepEqual(proto.createView({ swizzle: 'rgba' }), { view: true })
  assert.deepEqual(proto.createView(), { view: true })
  assert.deepEqual(proto.createView({}), { view: true })
  assert.deepEqual(seen, [undefined, undefined, undefined])
})

test('any swizzle other than the identity passes through untouched, and a second call wraps nothing more', () => {
  const calls: unknown[] = []
  const proto = { createView(d?: { swizzle?: unknown }) { calls.push(d?.swizzle); return calls.length } }
  tolerateIdentitySwizzle(proto)
  const once = proto.createView
  tolerateIdentitySwizzle(proto)
  assert.equal(proto.createView, once, 'idempotent')
  proto.createView({ swizzle: 'bgra' })
  proto.createView({ swizzle: 'rgba' })
  assert.deepEqual(calls, ['bgra', undefined])
  tolerateIdentitySwizzle(undefined)
})

test('createRenderer tolerates the identity swizzle before three creates a single view', () => {
  const world = readFileSync(new URL('./world.ts', import.meta.url), 'utf8')
  const body = world.slice(world.indexOf('export async function createRenderer'))
  assert.ok(body.indexOf('tolerateIdentitySwizzle()') >= 0, 'called')
  assert.ok(body.indexOf('tolerateIdentitySwizzle()') < body.indexOf('await renderer.init()'), 'before init')
})
