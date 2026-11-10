// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side wiring of the scene's multisampling (governor.ts msaaCandidate), which
 * the host, the engine and the world carry and Node cannot boot: the host's ?msaa; the renderer's own samples only for
 * split screen (which refuses a headset), decided from the adapter line before three is made; the post chain's samples
 * decided once at boot where the chain can run; the 1x rebuild when the browser refuses the 4x chain, with the boot's
 * own failure text kept; and no tier change ever touching a sample count.
 * What breaks if it is removed? A later edit could multisample every renderer (the headset's targets and Minimal's
 * direct path paying four samples for good), move the samples with a tier (rebuilding every pipeline mid-game), or boot
 * into a refused chain, and only a real GPU would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, `missing ${from} … ${to}`)
  return src.slice(a, b)
}
const APP = read('../App.tsx')
const ENGINE = read('./engine.ts')
const WORLD = read('../01_Initialize_World/world.ts')
const POSTFX = read('./postfx.ts')
const QUALITY = read('./quality.ts')
const CREATE = between(ENGINE, '  static async create(', '  /** The minimap')
/** Code that sets a sample count: `samples:` or `samples =` (prose that names samples is not code). */
const SETS_SAMPLES = /\bsamples\s*[:=]/

test('host: ?msaa=1|0 reaches the engine, absent leaves it to the device', () => {
  const opts = between(APP, 'function readOptions(): Options {', '\n}\n')
  assert.match(opts, /msaa: q\.get\('msaa'\) === '1' \? true : q\.get\('msaa'\) === '0' \? false : undefined,/)
  assert.match(ENGINE, /^ {2}msaa\?: boolean$/m, 'EngineOptions.msaa')
})

test('world: the renderer\'s own samples are the caller\'s decision on the adapter line, read before three is made', () => {
  const body = between(WORLD, 'export async function createRenderer', '\n}\n')
  assert.match(body, /samples: \(adapter: string\) => 0 \| 4 = \(\) => 0,/, 'none unless asked')
  assert.match(body, /new WebGPURenderer\(\{ canvas, antialias: false, samples: samples\(line\), [^}]*reversedDepthBuffer: true, device \}\)/)
  assert.ok(body.indexOf('adapterLine(info)') < body.indexOf('samples(line)'), 'the adapter line first')
})

test('engine: only split screen multisamples the renderer, by the same rule; a split screen never presents to a headset', () => {
  assert.match(CREATE, /return requested\.post && clampPlayers\(requested\.players\) > 1 && msaaCandidate\(h, profileDevice\(h, requested\.lite\), requested\.msaa, requested\.pixelRatio\) \? MSAA\.samples : 0/, '?post=0 turns them off too')
  assert.match(CREATE, /createRenderer\(canvas, requested\.pixelRatio, requested\.profile, peakOf, splitSamplesOf\)/)
  const xr = between(ENGINE, "  enterXr(mode: 'immersive-vr' | 'immersive-ar'): Promise<string> {", '\n  }\n')
  assert.match(xr, /if \(this\.views\.length > 1\) return Promise\.resolve\('no headset while the screen is split'\)/)
})

test('engine: the scene pass\'s samples are decided once, where the post chain can run, and reach buildPost', () => {
  assert.match(CREATE, /let sceneSamples: 0 \| 4 = options\.post && msaaCandidate\(hints, profile, requested\.msaa, requested\.pixelRatio\) \? MSAA\.samples : 0/)
  assert.ok(CREATE.indexOf('post: requested.post && players === 1 && !lite') < CREATE.indexOf('let sceneSamples'), 'after the post chain is capped (split screen, lite, ?post=0)')
  assert.match(CREATE, /buildPost\(gpu\.renderer, world\.scene, world\.camera, options\.cinema === false \? null : \{ resorted: world\.resorted \}, ghost, \{ sceneSamples: samples \}\)/)
  assert.match(CREATE, /let \{ pipeline: post, volumetrics, cinema, vision, release \} = chainOf\(sceneSamples\)/)
  assert.match(ENGINE, /^ {2}readonly sceneSamples: 0 \| 4$/m, 'the engine says what the boot chose (smoke, shot)')
  assert.match(CREATE, /hints, post, volumetrics, cinema, vision, sceneSamples, crowdFrameSeconds/)
})

test('engine: only the chain\'s own refusal rebuilds it at 1x, drawn again in its own scope; a direct-path refusal and anything else fail the boot as before', () => {
  const after = between(CREATE, 'const invalid = await gpu.device.popErrorScope()', 'const crowdLook = ')
  // The direct path's scope closes, and fails the boot on its own, before the chain is drawn.
  assert.ok(after.indexOf('if (invalid) throw new Error(') < after.indexOf('post.render()'), 'the direct path is judged alone, first')
  assert.doesNotMatch(after, /invalid && sceneSamples/, 'a direct-path refusal never rebuilds the chain')
  const fallback = between(after, 'if (refused && sceneSamples > 0) {', '} else if (refused) throw')
  const order = ['release()', 'sceneSamples = 0', 'chainOf(sceneSamples)', "gpu.device.pushErrorScope('validation')", 'post.render()', 'const retry = await gpu.device.popErrorScope()', 'stillThere()']
  for (let i = 1; i < order.length; i++) {
    assert.ok(fallback.indexOf(order[i - 1]) >= 0 && fallback.indexOf(order[i - 1]) < fallback.indexOf(order[i]), `${order[i - 1]} before ${order[i]}`)
  }
  assert.match(fallback, /if \(retry\) throw new Error\(`the first frame failed WebGPU validation: \$\{retry\.message\}`\)/)
  assert.match(after, /\} else if \(refused\) throw new Error\(`the first frame failed WebGPU validation: \$\{refused\.message\}`\)/)
  const post = between(after, 'const refused = await gpu.device.popErrorScope()', 'if (refused && sceneSamples > 0)')
  assert.match(post, /stillThere\(\)/, 'a lost device is reported first')
})

test('no tier change touches a sample count: applyTier and quality.ts set none; the ghost pass pins one sample', () => {
  const tier = between(ENGINE, '  private applyTier(): void {', '\n  }\n')
  assert.doesNotMatch(tier, SETS_SAMPLES)
  assert.doesNotMatch(QUALITY, SETS_SAMPLES)
  assert.match(POSTFX, /pass\(ghost\.scene, camera, \{ samples: 0 \}\)/)
  assert.match(POSTFX, /pass\(scene, camera, \{ samples: aa\.sceneSamples, storeMultisampledColorBuffer: !multisampled \}\)/)
})
