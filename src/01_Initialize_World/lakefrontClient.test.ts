// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the map builder's protocol over the inline port: the stages arrive in order and in
 * plain words, a pack asked for before the build is done still arrives, the pack starts the visitor in the asked zone
 * (that zone's centre is at the origin), the same bytes come from the one-call build, and a disposed builder refuses.
 * A worker that fails as a whole (its error event, which is never a message) rejects the build and every pack asked
 * for, before or after the build, so a returning visitor is never left waiting on the splash. And it runs the worker's
 * own handler (lakefront.worker.ts, in this process) beside the inline port: each of the five zones asked for is the
 * zone the pack starts in, on both, byte for byte, and anything that is no zone starts in the metropolis. (The worker
 * once tested the zone with `in ZONE`, which reads ZONE's keys, so it built the metropolis whatever was chosen, and
 * only the inline port, the one the other tests use, was right.)
 * What breaks if it is removed? The worker and the page could disagree on the protocol, the spawn drift from the zone,
 * the visitor's chosen region be ignored in the browser alone, or a dead builder hang the boot again.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ZONE, generateLakefront, type Zone } from './lakefront.ts'
import { LakefrontBuilder, inlinePort, reportingPort, type BuilderWorker } from './lakefrontClient.ts'
import { BUILD_STAGES, STAGE_WORDS, WALK_BLOCKS, buildLakefrontPack, packOf, startZone, zoneCentre, zoneOf, type FromWorker, type ToWorker } from './lakefrontPack.ts'
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

test('startZone: exactly the five regions\' ids; the metropolis for the lake, a number that is no zone, a name, nothing', () => {
  for (const zone of [ZONE.metropolis, ZONE.westSprawl, ZONE.eastBluffs, ZONE.northRidge, ZONE.grandRavine]) assert.equal(startZone(zone), zone)
  for (const junk of [ZONE.lake, 6, -1, 1.5, NaN, '1', 'the-grand-ravine', null, undefined, {}, [3]]) assert.equal(startZone(junk), ZONE.metropolis, `${String(junk)} is no zone`)
  // ZONE's keys are the regions' names in code, never a zone: what `zone in ZONE` took for one.
  for (const key of Object.keys(ZONE)) assert.equal(startZone(key), ZONE.metropolis, key)
})

/**
 * The builder's real worker (lakefront.worker.ts) run in this process: it takes `self` as its scope the moment it
 * loads, so a stand-in is `self` for the import and is taken away again. `ask` posts one message and returns what the
 * worker said back to it (the worker answers before it returns).
 */
async function workerInProcess(): Promise<{ ask(m: ToWorker): FromWorker[] }> {
  const said: FromWorker[] = []
  const scope: { postMessage(m: FromWorker): void; onmessage: ((e: { data: ToWorker }) => void) | null } = { postMessage: (m) => { said.push(m) }, onmessage: null }
  const was = Object.getOwnPropertyDescriptor(globalThis, 'self')
  Object.defineProperty(globalThis, 'self', { configurable: true, value: scope })
  try {
    await import('./lakefront.worker.ts')
  } finally {
    if (was) Object.defineProperty(globalThis, 'self', was)
    else delete (globalThis as { self?: unknown }).self
  }
  const hear = scope.onmessage
  assert.ok(hear, 'the worker listens on its scope')
  return { ask: (m) => { said.length = 0; hear({ data: m }); return said.slice() } }
}

test('the worker and the inline port start the pack in the asked zone, each of the five, and in the metropolis for anything that is no zone: the same pack from both', async () => {
  const worker = await workerInProcess()
  const inline = inlinePort()
  const heard: FromWorker[] = []
  inline.onmessage = (e) => { heard.push(e.data) }
  const ports: [string, (m: ToWorker) => FromWorker[]][] = [
    ['the worker', worker.ask],
    ['the inline port', (m) => { heard.length = 0; inline.postMessage(m); return heard.slice() }],
  ]
  const kinds = (replies: FromWorker[]) => replies.map((m) => (m.kind === 'stage' ? m.stage : m.kind))
  let id = 0
  const packFrom = (ask: (m: ToWorker) => FromWorker[], zone: unknown, what: string) => {
    const replies = ask({ kind: 'pack', zone: zone as Zone, id: ++id })
    assert.deepEqual(kinds(replies), ['names', 'ready', 'pack'], what)
    const last = replies[2]
    assert.ok(last.kind === 'pack' && last.id === id, `${what}: the answer names its request`)
    return last.pack
  }
  // Before the build there is no map to make a pack of: an error that names the request, from both.
  for (const [name, ask] of ports) assert.deepEqual(ask({ kind: 'pack', zone: ZONE.westSprawl, id: ++id }), [{ kind: 'error', message: 'no map was built yet', id }], name)
  for (const [name, ask] of ports) assert.deepEqual(kinds(ask({ kind: 'build', seed: 1337, blocks: WALK_BLOCKS })), [...BUILD_STAGES.slice(0, 5), 'built'], name)
  const map = generateLakefront(1337, WALK_BLOCKS)
  const starts: string[] = []
  for (const zone of [ZONE.metropolis, ZONE.westSprawl, ZONE.eastBluffs, ZONE.northRidge, ZONE.grandRavine]) {
    const want = packOf(map, zone)
    const c = zoneCentre(map, zone)
    for (const [name, ask] of ports) {
      const pack = packFrom(ask, zone, `${name}, zone ${zone}`)
      // The asked zone's centre is the pack's origin, and the asked zone is the quarter the visitor chose.
      assert.deepEqual(pack.bounds, { x0: -c.x, z0: -c.z, x1: WALK_BLOCKS * MACRO.pitch - c.x, z1: WALK_BLOCKS * MACRO.pitch - c.z }, `${name}: zone ${zone} is where the pack starts`)
      assert.equal(pack.quarters?.home, zone, `${name}: zone ${zone} is the pack's home quarter`)
      assert.deepEqual(pack, want, `${name}: zone ${zone}, the very pack packOf makes`)
    }
    starts.push(`${c.x},${c.z}`)
  }
  assert.equal(new Set(starts).size, 5, 'five zones, five starts')
  // Anything that is no zone starts in the metropolis: the lake, a number past the zones, a name (ZONE's keys among them), nothing.
  const metropolis = packOf(map, ZONE.metropolis)
  for (const junk of [ZONE.lake, 7, -1, 1.5, 'westSprawl', '1', null, undefined]) {
    for (const [name, ask] of ports) assert.deepEqual(packFrom(ask, junk, `${name}, asked for ${String(junk)}`), metropolis, `${name}: ${String(junk)} is no zone`)
  }
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
