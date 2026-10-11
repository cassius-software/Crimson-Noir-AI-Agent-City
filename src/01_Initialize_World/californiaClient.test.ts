// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the map builder's protocol over the inline port: the stages arrive in order and in
 * plain words, a pack asked for before the build is done still arrives, the pack starts the visitor in the asked zone
 * (that zone's centre is at the origin), the same bytes come from the one-call build, and a disposed builder refuses.
 * What breaks if it is removed? The worker and the page could disagree on the protocol, or the spawn drift from the zone.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ZONE, generateCalifornia } from './california.ts'
import { CaliforniaBuilder, inlinePort } from './californiaClient.ts'
import { BUILD_STAGES, STAGE_WORDS, WALK_BLOCKS, buildCaliforniaPack, zoneCentre, zoneOf } from './californiaPack.ts'
import { MACRO } from './macroCity.ts'

test('the stages arrive in order, each with plain words; a pack asked early arrives after the build', async () => {
  const stages: string[] = []
  const got: { built: readonly number[] | null; grid: Uint8Array | null } = { built: null, grid: null }
  const b = new CaliforniaBuilder(1337, inlinePort(), { onStage: (s) => stages.push(s), onBuilt: (z, g) => { got.built = z; got.grid = g } })
  const pack = await b.pack(ZONE.lasVistas)
  assert.deepEqual(stages, [...BUILD_STAGES])
  for (const s of BUILD_STAGES) assert.match(STAGE_WORDS[s], /^[A-Z][a-z]/)
  assert.ok(got.built && got.built.length === 6 && got.built[ZONE.ocean] > 0)
  assert.ok(got.grid && got.grid.length === WALK_BLOCKS * WALK_BLOCKS && got.grid[0] === ZONE.ocean)
  assert.equal(pack.name, 'Sunfall Coast')
  assert.equal(b.blocks, WALK_BLOCKS)
  // The asked zone's centre is the pack's origin: the engine spawns on the arterial sidewalk nearest it.
  const map = generateCalifornia(1337, WALK_BLOCKS)
  const c = zoneCentre(map, ZONE.lasVistas)
  assert.deepEqual(pack.bounds, { x0: -c.x, z0: -c.z, x1: WALK_BLOCKS * MACRO.pitch - c.x, z1: WALK_BLOCKS * MACRO.pitch - c.z })
  assert.equal(map.zones[Math.floor(c.z / MACRO.pitch) * WALK_BLOCKS + Math.floor(c.x / MACRO.pitch)], ZONE.lasVistas)
  // The same bytes as the one-call build.
  assert.deepEqual(pack, buildCaliforniaPack(1337, ZONE.lasVistas))
  // Another zone, another origin, the same streets.
  const other = await b.pack(ZONE.sanCero)
  assert.notDeepEqual(other.bounds, pack.bounds)
  assert.deepEqual(other.names, pack.names)
  b.dispose()
  await assert.rejects(b.pack(ZONE.delMar), /disposed/)
})

test('zoneOf maps the saved slug to its zone, and nothing else', () => {
  assert.equal(zoneOf('starwood-hills'), ZONE.starwood)
  assert.equal(zoneOf('del-mar-metropolis'), ZONE.delMar)
  assert.equal(zoneOf('hollywood'), null)
  assert.equal(zoneOf(null), null)
})
