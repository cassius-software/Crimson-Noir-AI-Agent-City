// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side wiring of Peak, the tier above Ultra (governor.ts PEAK), which the
 * host, the engine and the world carry and Node cannot boot: the host's ?quality=5|peak and ?peak; three writing GPU
 * timestamps only for a Peak candidate, decided from the adapter line before three is made; the automatic range
 * reaching Peak only where three really writes them; the engine resolving timings only where three writes them, and
 * feeding them to the governor; the drawing buffer fitted to the device's largest 2D texture, and refitted on resize;
 * the sun's shadow box world.ts builds matching the applier's constant; and no model choice reading the tier.
 * What breaks if it is removed? A later edit could write timestamps on every device (three's warning then fails the
 * browser smoke), offer Peak where nothing can judge it, or let the shadow box drift from the applier's, silently.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { SHADOW_EXTENT } from './quality.ts'
import { PEAK, PEAK_TIER } from '../05_Observe_Environment/governor.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, `missing ${from} … ${to}`)
  return src.slice(a, b)
}
const APP = read('../App.tsx')
const ENGINE = read('./engine.ts')
const WORLD = read('../01_Initialize_World/world.ts')
const CREATE = between(ENGINE, '  static async create(', '  /** The minimap')

test('host: ?quality takes 5 and the word peak, and ?peak=1|0 reaches the engine', () => {
  const opts = between(APP, 'function readOptions(): Options {', '\n}\n')
  assert.match(opts, /quality === 'lite' \? -1 : quality === 'peak' \? 5 : Math\.round\(num\('quality', 3, -1, 5\)\)/)
  assert.match(opts, /peak: q\.get\('peak'\) === '1' \? true : q\.get\('peak'\) === '0' \? false : undefined,/)
  assert.match(ENGINE, /^ {2}peak\?: boolean$/m, 'EngineOptions.peak')
})

test('engine: a Peak candidate\'s three writes timestamps, and the range reaches Peak only where it does', () => {
  // Decided from the adapter line before three is made, by the same profile the city takes.
  assert.match(CREATE, /peakCandidate\(h, profileDevice\(h, requested\.lite\), requested\.peak\)/)
  assert.match(CREATE, /createRenderer\(canvas, requested\.pixelRatio, requested\.profile, peakOf\)/)
  // Without GPU timestamps nothing can judge Peak, so the range stops at Ultra.
  assert.match(CREATE, /const peak = gpu\.timestamps && peakCandidate\(hints, profile, requested\.peak\)/)
  assert.match(CREATE, /const range = tierRange\(profile, peak\)/)
  assert.ok(CREATE.indexOf('const lite = profile.lite') < CREATE.indexOf('const peak = '), 'the profile first, as liteWiring pins it')
})

test('engine: timings are resolved only where three writes them, and feed the governor', () => {
  assert.match(ENGINE, /if \(this\.gpu\.timestamps && \(this\.options\.profile \|\| this\.quality\.governor\.wantsGpu\) && !this\.resolving\)/)
  assert.match(ENGINE, /this\.quality\.governor\.gpuSample\(ms, performance\.now\(\)\)/)
  // The evidence is render passes only: the crowd's compute is timed under ?profile alone, as before.
  assert.match(CREATE, /if \(options\.profile\) crowd\.enableProfiling\(\)/)
})

test('engine: the drawing buffer is fitted to the device\'s 2D texture limit, and refitted on resize', () => {
  assert.match(CREATE, /fit: \{ maxEdge: gpu\.device\.limits\.maxTextureDimension2D, cssEdge: \(\) => Math\.max\(1, canvas\.clientWidth, canvas\.clientHeight\) \}/)
  const resize = between(ENGINE, '  resize(): void {', '\n  }\n')
  assert.match(resize, /setSize\(w, h, false\)\n\s+(?:\/\/.*\n\s+)*refitPixelRatio\(this\.quality\.applied, this\.quality\.targets\)/)
})

test('world: three is asked for timestamps by the caller\'s decision on the adapter line, read before three is made', () => {
  const body = between(WORLD, 'export async function createRenderer', '\n}\n')
  assert.match(body, /trackTimestamp: profile \|\| timestamps\(line\)/)
  assert.ok(body.indexOf('adapterLine(info)') >= 0 && body.indexOf('adapterLine(info)') < body.indexOf('new WebGPURenderer('), 'the adapter line before three')
  // What three kept (the device has timestamp-query), not what was asked.
  assert.match(body, /timestamps: backend\.trackTimestamp === true/)
})

test('world: the sun\'s shadow box is the applier\'s SHADOW_EXTENT, and Peak doubles it at twice the map edge', () => {
  assert.match(WORLD, /sc\.left = -80; sc\.right = 80; sc\.top = 80; sc\.bottom = -80;/)
  assert.equal(SHADOW_EXTENT, 80)
  assert.equal(PEAK_TIER, 5)
  assert.equal(PEAK.shadowExtent, 2 * SHADOW_EXTENT)
})

test('models: no model choice reads the tier', () => {
  for (const f of ['../09_Cognition/router.ts', '../09_Cognition/localCompute.ts']) {
    assert.doesNotMatch(read(f), /PEAK|peakCandidate|wantsGpu/, f)
  }
})
