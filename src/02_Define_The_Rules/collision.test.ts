/**
 * Why does this file exist? It is the structural guard on the realm's contact policy: the COLLISION record is frozen
 * and says what it must (cars pass through cars, the ragdoll balance machine wired, no combat); the ragdoll reaches
 * the realm by one road only — the two ragdoll sources are imported at run time by the realm module alone
 * (07_Execute_Actions/ragdollRealm.ts; the protocol takes a type), the realm module by the simulation core alone, and
 * the word appears in the code of the listed files and nowhere else (never in the worker entry, the fleet, the
 * world, the avatar or the sanctuary, not even in a comment); a vehicle is not a cause the ragdoll accepts; the pool
 * holds eight; and the group bit table cannot drift from the packing and the bit the ragdoll rig uses (read from its
 * source text, since importing it would load Rapier). Pure: no WASM.
 * What breaks if it is removed? A second road to the ragdoll could land in the realm unnoticed, a chassis could share
 * a bit with its segments, or the policy record could quietly change.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_GROUPS, AVATAR_GROUPS, COLLISION, GROUP, interactionGroups, VEHICLE_CHASSIS_GROUPS, WHEEL_RAY_GROUPS } from './collision.ts'
import { PERTURBATION_CAUSES, POOL_CAPACITY } from '../03_Spawn_Agents/ragdoll.ts'
import { RIG_SLOTS } from '../07_Execute_Actions/simProtocol.ts'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const SELF = fileURLToPath(import.meta.url)
/** The two sources that are the ragdoll: the balance machine and the pool, and the Rapier body. */
const RAGDOLL_FILES = ['03_Spawn_Agents/ragdoll.ts', '03_Spawn_Agents/ragdollRig.ts']
/** The one runtime importer of both: the realm module. */
const REALM_MODULE = '07_Execute_Actions/ragdollRealm.ts'
/** The protocol imports a type from the machine (BalanceState, for the stream's codes): never a value. */
const PROTOCOL_FILE = '07_Execute_Actions/simProtocol.ts'
/** The one runtime importer of the realm module: the simulation core. */
const CORE_FILE = '07_Execute_Actions/simCore.ts'
/**
 * The runtime files whose code may say the word: the policy, the two sources, the realm module, the core, the
 * protocol, the door (it reads SimInit.ragdoll), the shell (it reads ?ragdoll), the frame loop and the rig view.
 */
const MAY_NAME = [
  '02_Define_The_Rules/collision.ts',
  ...RAGDOLL_FILES,
  REALM_MODULE,
  CORE_FILE,
  PROTOCOL_FILE,
  '07_Execute_Actions/simHost.ts',
  'App.tsx',
  '07_Execute_Actions/engine.ts',
  '07_Execute_Actions/rigView.ts',
]
/** The rest of the realm: these contain the word nowhere, not even in a comment. */
const REALM_FILES = [
  '07_Execute_Actions/physics.worker.ts',
  '07_Execute_Actions/vehicles.ts',
  '07_Execute_Actions/physics.ts',
  '07_Execute_Actions/player.ts',
  '07_Execute_Actions/sanctuary.ts',
]

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p)
    else if (/\.(ts|tsx)$/.test(name)) yield p
  }
}

/** The code of a source file without its comments (a line comment starts at // not preceded by a colon, as in URLs). */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Every runtime (non-test) source under src/, as [relative path, text]. */
function runtimeSources(): [string, string][] {
  return [...files(SRC)]
    .filter((f) => f !== SELF && !/\.test\.tsx?$/.test(f) && !/\.d\.ts$/.test(f))
    .map((f) => [relative(SRC, f).replaceAll('\\', '/'), readFileSync(f, 'utf8')])
}

test('COLLISION is frozen and says: cars pass through cars, the ragdoll wired, no combat, sensor furniture, the sanctuary between people and cars', () => {
  assert.ok(Object.isFrozen(COLLISION))
  assert.deepEqual(COLLISION, { vehicleOnVehicle: false, ragdoll: true, combat: false, furniture: 'sensor', peopleAndCars: 'sanctuary' })
  assert.equal(COLLISION.vehicleOnVehicle, false)
  assert.equal(COLLISION.ragdoll, true)
  assert.equal(COLLISION.combat, false)
  assert.throws(() => { (COLLISION as { combat: boolean }).combat = true }, TypeError)
  assert.ok(Object.isFrozen(GROUP))
})

test('one road to the ragdoll: its sources are imported at run time by the realm module alone, the realm module by the core alone, and only the listed files name it', () => {
  const sources = runtimeSources()
  assert.ok(sources.length > 50, `${sources.length} runtime sources read`)
  const importers = { sources: [] as string[], realm: [] as string[] }
  for (const [name, text] of sources) {
    for (const m of text.matchAll(/\b(import\s+type\s+[^'"]*?\s+from|from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[2]
      const typeOnly = m[1].startsWith('import type')
      if (/\/ragdollRealm\.ts$/.test(spec)) importers.realm.push(name)
      else if (/\/ragdoll(Rig)?\.ts$/.test(spec) || /^\.\/ragdoll(Rig)?\.ts$/.test(spec)) {
        if (typeOnly && name === PROTOCOL_FILE) continue
        importers.sources.push(name)
      } else assert.doesNotMatch(spec, /ragdoll/i, `${name} imports ${spec}`)
    }
    // Only the listed files say the word in their code (comments stripped).
    if (MAY_NAME.includes(name)) continue
    const m = code(text).match(/ragdoll/i)
    assert.equal(m, null, `${name} names the ragdoll in its code`)
  }
  // The rig imports the machine; beyond that, the realm module alone imports either at run time.
  assert.deepEqual(new Set(importers.sources), new Set(['03_Spawn_Agents/ragdollRig.ts', REALM_MODULE]), importers.sources.join(', '))
  assert.deepEqual(importers.realm, [CORE_FILE])
  for (const f of REALM_FILES) {
    const text = readFileSync(join(SRC, f), 'utf8')
    assert.doesNotMatch(text, /ragdoll/i, `${f} mentions the ragdoll`)
  }
  assert.equal(code("import { x } from './a.ts' // ragdoll\n/* ragdoll */ const y = 1").match(/ragdoll/), null, 'comments are stripped')
  assert.ok(code("const z = 'ragdoll'").match(/ragdoll/), 'a string is caught')
})

test('a vehicle is not a cause the ragdoll accepts (restated as policy), and the pool holds eight', () => {
  assert.ok(Object.isFrozen(PERTURBATION_CAUSES))
  assert.ok(!(PERTURBATION_CAUSES as readonly string[]).includes('vehicle'))
  assert.ok(PERTURBATION_CAUSES.length > 0)
  assert.equal(POOL_CAPACITY, 8)
  assert.equal(RIG_SLOTS, POOL_CAPACITY)
})

test('the group arithmetic: Rapier packing, the ragdoll bit read from ragdollRig.ts, disjoint bits, the avatar through a rig', () => {
  assert.equal(interactionGroups(0x0004, 0xffff & ~0x0004), (0x0004 << 16) | 0xfffb)
  assert.equal(interactionGroups(0xffff, 0xffff), 0xffffffff, 'a u32, never a negative number')
  assert.equal(interactionGroups(0x10002, 0x1fffd), 0x0002fffd, 'each word is 16 bits')
  assert.equal(ALL_GROUPS, 0xffff)

  const rig = readFileSync(join(SRC, '03_Spawn_Agents/ragdollRig.ts'), 'utf8')
  const m = rig.match(/RAGDOLL_GROUP\s*=\s*(0x[0-9a-f]+)/i)
  assert.ok(m, 'ragdollRig.ts declares RAGDOLL_GROUP as a hex literal')
  assert.equal(GROUP.ragdoll, Number(m![1]), 'the bit table holds the bit the rig uses')
  assert.equal(GROUP.ragdoll, 0x0004)
  assert.match(rig, /\(RAGDOLL_GROUP << 16\) \| \(0xffff & ~RAGDOLL_GROUP\)/, 'the rig packs (membership << 16) | filter, as interactionGroups does')

  assert.equal(GROUP.vehicle & GROUP.ragdoll, 0)
  assert.equal(GROUP.query & GROUP.vehicle, 0)
  assert.equal(GROUP.query & GROUP.ragdoll, 0)

  assert.equal(VEHICLE_CHASSIS_GROUPS, 0x0002fffd)
  assert.equal(WHEEL_RAY_GROUPS, 0x0001fffd)
  // Rapier's rule, spelled out: a and b interact iff ((a >> 16) & b) != 0 and ((b >> 16) & a) != 0.
  const meets = (a: number, b: number) => ((a >>> 16) & b & 0xffff) !== 0 && ((b >>> 16) & a & 0xffff) !== 0
  const DEFAULT = interactionGroups(ALL_GROUPS, ALL_GROUPS)
  assert.equal(meets(VEHICLE_CHASSIS_GROUPS, VEHICLE_CHASSIS_GROUPS), false, 'chassis vs chassis: no pair')
  assert.equal(meets(VEHICLE_CHASSIS_GROUPS, DEFAULT), true, 'chassis vs ground, building, avatar: solid')
  assert.equal(meets(WHEEL_RAY_GROUPS, VEHICLE_CHASSIS_GROUPS), false, 'a wheel ray never finds a chassis')
  assert.equal(meets(WHEEL_RAY_GROUPS, DEFAULT), true, 'a wheel ray finds the road')
  assert.equal(meets(DEFAULT, VEHICLE_CHASSIS_GROUPS), true, 'the obstacle rays (default groups) still find a chassis')
  const ragdoll = interactionGroups(GROUP.ragdoll, ALL_GROUPS & ~GROUP.ragdoll)
  assert.equal(meets(ragdoll, VEHICLE_CHASSIS_GROUPS), true, 'a rig segment meets a chassis as it meets the world: the Sanctuary stands between them')
  assert.equal(meets(ragdoll, DEFAULT), true, 'a rig segment stands on the ground')
  assert.equal(meets(ragdoll, ragdoll), false, 'segments never meet each other')
  assert.equal(AVATAR_GROUPS, 0xfffffffb)
  assert.equal(meets(AVATAR_GROUPS, ragdoll), false, 'the avatar walks through a promoted person (the ghost-mode law)')
  assert.equal(meets(AVATAR_GROUPS, VEHICLE_CHASSIS_GROUPS), true, 'and is as solid as ever to a car')
  assert.equal(meets(AVATAR_GROUPS, DEFAULT), true, 'and to the ground and the buildings')
  assert.equal(meets(WHEEL_RAY_GROUPS, ragdoll), true, 'a wheel ray finds a solid segment (a sensor one it excludes by flag, as it does the avatar)')
})
