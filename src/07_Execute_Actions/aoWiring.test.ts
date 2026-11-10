// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side wiring of the ambient occlusion (postfx.ts GatedSSAO, governor.ts
 * aoCandidate), which the host, the engine and the post chain carry and Node cannot boot: the host's ?ao; the build
 * decided once at boot where the chain can run, and kept through the 1x rebuild; the frame writing only its switch, taps
 * and strength from the tier, off in rain mode; no tier change touching what would recompile it (its resolution, its
 * blur, the scene pass's targets); and the chain taking three's SSAONode alone (no GTAO, whose depth gather a
 * multisampled depth texture refuses, no reflections, no material-level occlusion).
 * What breaks if it is removed? A later edit could build the occlusion on every phone, run it at every tier, resize or
 * recompile it on a tier change, or swap in GTAO that refuses the 4x chain at boot, and only a real GPU would show it.
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
const POSTFX = read('./postfx.ts')
const QUALITY = read('./quality.ts')
const CREATE = between(ENGINE, '  static async create(', '  /** The minimap')

test('host: ?ao=1|0 reaches the engine, absent leaves it to the device', () => {
  const opts = between(APP, 'function readOptions(): Options {', '\n}\n')
  assert.match(opts, /ao: q\.get\('ao'\) === '1' \? true : q\.get\('ao'\) === '0' \? false : undefined,/)
  assert.match(ENGINE, /^ {2}ao\?: boolean$/m, 'EngineOptions.ao')
})

test('engine: the occlusion is built once, where the post chain can run, and survives the 1x rebuild', () => {
  assert.match(CREATE, /const aoBuilt = options\.post && aoCandidate\(profile, requested\.ao\)/)
  assert.ok(CREATE.indexOf('post: requested.post && players === 1 && !lite') < CREATE.indexOf('const aoBuilt'), 'after the post chain is capped (split screen, lite, ?post=0)')
  assert.match(CREATE, /\{ sceneSamples: samples, ao: aoBuilt \}\)/)
  assert.match(CREATE, /let \{ pipeline: post, volumetrics, cinema, ao, release \} = chainOf\(sceneSamples\)/)
  assert.match(CREATE, /;\(\{ pipeline: post, volumetrics, cinema, ao, release \} = chainOf\(sceneSamples\)\)/, 'the 1x rebuild takes the new chain\'s occlusion')
  assert.match(CREATE, /setAmbientOcclusion: \(taps\) => \{ live\.ao = taps \},/)
  assert.match(ENGINE, /^ {2}readonly ao: AmbientOcclusion \| null$/m, 'the engine holds what the boot built (smoke, shot)')
})

test('engine: each frame writes the switch, the taps and the strength from the tier, and rain mode turns it off', () => {
  const frame = between(ENGINE, '    if (this.ao) {', '\n    }\n')
  assert.match(frame, /const taps = this\.quality\.live\.ao/)
  assert.match(frame, /const on = taps > 0 && !this\.matrixOn && this\.aoScale > 0/, 'off at the operator\'s strength 0 too: nothing to apply, so no passes')
  assert.match(frame, /this\.ao\.node\.on = on/)
  assert.match(frame, /if \(on\) this\.ao\.node\.samples\.value = taps/, 'a tap count only while on: never 0, which the occlusion divides by')
  assert.match(frame, /this\.ao\.strength\.value = on \? this\.aoScale : 0/)
  assert.ok(ENGINE.indexOf('    if (this.ao) {') < ENGINE.indexOf('    if (post) this.post.render()'), 'written before the chain renders')
})

test('quality: a post cap writes no taps; no tier change touches what would recompile the occlusion', () => {
  assert.match(QUALITY, /const ao = k\.post \? k\.aoTaps : 0\n {2}if \(!prev \|\| \(prev\.post \? prev\.aoTaps : 0\) !== ao\) t\.setAmbientOcclusion\(ao\)/)
  const tier = between(ENGINE, '  private applyTier(): void {', '\n  }\n')
  for (const src of [tier, QUALITY]) {
    for (const word of ['resolutionScale', 'blurEnabled', 'contextNode', 'setMRT']) assert.ok(!src.includes(word), word)
  }
})

test('postfx: three\'s SSAONode alone, gated, applied behind its strength after the shutter, bloom taken before it', () => {
  for (const word of ['GTAONode', 'SSRNode', 'builtinAOContext', '.gather(']) assert.ok(!POSTFX.includes(word), word)
  assert.match(POSTFX, /import SSAONode from 'three\/addons\/tsl\/display\/SSAONode\.js'/)
  assert.match(POSTFX, /export class GatedSSAO extends SSAONode \{/)
  assert.match(POSTFX, /if \(!this\.on && this\.primed\) return undefined\n {4}this\.primed = true\n {4}return super\.updateBefore\(frame\)/)
  assert.match(POSTFX, /If\(ao\.strength\.greaterThan\(0\), \(\) => \{/)
  assert.match(POSTFX, /const ao = aa\.ao \? buildAo\(scenePass, camera\) : null/)
  assert.match(POSTFX, /\.\.\.\(ao \? \[ao\.node\] : \[\]\)\]/, 'release() owns it')
  // Bloom reads the light before the occlusion; the rays are added after it, never occluded.
  assert.match(POSTFX, /const glow = bloom\(color, 0\.3, 0\.3, 4\.0\)/)
  assert.match(POSTFX, /const glow = bloom\(exposed, 0\.3, 0\.3, 4\.0\)/)
  assert.equal((POSTFX.match(/const lit = shaded\.add\(glow\.rgb\)\.add\(rays\.rgb\)\.mul\(vignette\)/g) ?? []).length, 2, 'both chains')
})
