// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the map builder's protocol over the inline port: the stages arrive in order and in
 * plain words, a pack asked for before the build is done still arrives, the pack starts the visitor in the asked zone
 * (that zone's centre is at the origin), the same bytes come from the one-call build, and a disposed builder refuses.
 * A worker that fails as a whole (its error event, which is never a message) rejects the build and every pack asked
 * for, before or after the build, so a returning visitor is never left waiting on the splash.
 * What breaks if it is removed? The worker and the page could disagree on the protocol, the spawn drift from the zone,
 * or a dead builder hang the boot again.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ZONE, generateLakefront } from './lakefront.ts'
import { LakefrontBuilder, inlinePort, reportingPort, type BuilderWorker } from './lakefrontClient.ts'
import { BUILD_STAGES, STAGE_WORDS, WALK_BLOCKS, buildLakefrontPack, zoneCentre, zoneOf } from './lakefrontPack.ts'
import { MACRO } from './macroCity.ts'

test('the stages arrive in order, each with plain words; a pack asked early arrives after the build', async () => {
  const stages: string[] = []
  const got: { built: readonly number[] | null; grid: Uint8Array | null } = { built: null, grid: null }
  const b = new LakefrontBuilder(1337, inlinePort(), { onStage: (s) => stages.push(s), onBuilt: (z, g) => { got.built = z; got.grid = g } })
  const pack = await b.pack(ZONE.northRidge)
  assert.deepEqual(stages, [...BUILD_STAGES])
  for (const s of BUILD_STAGES) assert.match(STAGE_WORDS[s], /^[A-Z][a-z]/)
  assert.ok(got.built && got.built.length === 6 && got.built[ZONE.lake] > 0)
  assert.ok(got.grid && got.grid.length === WALK_BLOCKS * WALK_BLOCKS && got.grid[WALK_BLOCKS * WALK_BLOCKS - 1] === ZONE.lake)
  assert.equal(pack.name, 'Lakefront Metro')
  assert.equal(b.blocks, WALK_BLOCKS)
  // The asked zone's centre is the pack's origin: the engine spawns on the arterial sidewalk nearest it.
  const map = generateLakefront(1337, WALK_BLOCKS)
  const c = zoneCentre(map, ZONE.northRidge)
  assert.deepEqual(pack.bounds, { x0: -c.x, z0: -c.z, x1: WALK_BLOCKS * MACRO.pitch - c.x, z1: WALK_BLOCKS * MACRO.pitch - c.z })
  assert.equal(map.zones[Math.floor(c.z / MACRO.pitch) * WALK_BLOCKS + Math.floor(c.x / MACRO.pitch)], ZONE.northRidge)
  // The same bytes as the one-call build.
  assert.deepEqual(pack, buildLakefrontPack(1337, ZONE.northRidge))
  // Another zone, another origin, the same streets.
  const other = await b.pack(ZONE.westSprawl)
  assert.notDeepEqual(other.bounds, pack.bounds)
  assert.deepEqual(other.names, pack.names)
  b.dispose()
  await assert.rejects(b.pack(ZONE.metropolis), /disposed/)
})

test('zoneOf maps the saved slug to its zone, and nothing else', () => {
  assert.equal(zoneOf('the-grand-ravine'), ZONE.grandRavine)
  assert.equal(zoneOf('lakefront-metropolis'), ZONE.metropolis)
  assert.equal(zoneOf('toronto'), null)
  assert.equal(zoneOf(null), null)
})

/** A worker that answers nothing and can be made to fail as a whole, as a Worker does (an `error` event). */
function dyingWorker() {
  const posted: unknown[] = []
  let prevented = 0
  const w: BuilderWorker = { onmessage: null, onerror: null, postMessage: (m) => { posted.push(m) }, terminate: () => {} }
  return { port: reportingPort(w), posted, die: (message = 'Uncaught RangeError: out of memory') => w.onerror?.({ message, preventDefault: () => { prevented++ } }), prevented: () => prevented }
}

test('a builder worker that dies rejects the build and every pack, instead of leaving the boot waiting', async () => {
  const early = dyingWorker()
  const b = new LakefrontBuilder(1337, early.port)
  const asked = b.pack(ZONE.metropolis)
  early.die()
  await assert.rejects(asked, /the map builder stopped: Uncaught RangeError: out of memory/)
  assert.equal(early.prevented(), 1, 'the error event is handled, not reported again')
  // After the build: a pack already asked for and one asked later both reject.
  const late = dyingWorker()
  const c = new LakefrontBuilder(1337, late.port)
  late.port.onmessage?.({ data: { kind: 'built', seed: 1337, blocks: WALK_BLOCKS, zoneBlocks: [1, 1, 1, 1, 1, 1], zones: new Uint8Array(0) } })
  const pending = c.pack(ZONE.metropolis)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(late.posted.filter((m) => (m as { kind: string }).kind === 'pack').length, 1)
  late.die('worker error')
  await assert.rejects(pending, /the map builder stopped/)
  await assert.rejects(c.pack(ZONE.lake), /the map builder stopped/)
  c.dispose()
})
