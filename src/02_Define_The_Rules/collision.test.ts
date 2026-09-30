/**
 * Why does this file exist? It is the structural guard on the realm's contact policy: the COLLISION record is frozen
 * and says what it must (cars pass through cars, no ragdoll, no combat); the ragdoll scaffold stays unwired — no
 * runtime file outside the two ragdoll sources imports or names it, and the realm's own files (the worker, the sim
 * core, the fleet, the world, the avatar, the sanctuary) contain the word nowhere; a vehicle is not a cause the
 * ragdoll accepts; and the group bit table cannot drift from the packing and the bit the ragdoll rig reserves (read
 * from its source text, since importing it would load Rapier). Pure: no WASM.
 * What breaks if it is removed? A ragdoll import could land in the realm unnoticed, a chassis could share a bit with
 * the ragdoll's segments, or the policy record could quietly gain a `true`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_GROUPS, COLLISION, GROUP, interactionGroups, VEHICLE_CHASSIS_GROUPS, WHEEL_RAY_GROUPS } from './collision.ts'
import { PERTURBATION_CAUSES } from '../03_Spawn_Agents/ragdoll.ts'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const SELF = fileURLToPath(import.meta.url)
/** The two sources that are the ragdoll scaffold, and the policy file that reserves its bit by name. */
const RAGDOLL_FILES = ['03_Spawn_Agents/ragdoll.ts', '03_Spawn_Agents/ragdollRig.ts']
const POLICY_FILE = '02_Define_The_Rules/collision.ts'
/** The realm: these contain the word nowhere, not even in a comment. */
const REALM_FILES = [
  '07_Execute_Actions/physics.worker.ts',
  '07_Execute_Actions/simCore.ts',
  '07_Execute_Actions/simHost.ts',
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

test('COLLISION is frozen and says: cars pass through cars, no ragdoll, no combat, sensor furniture, the sanctuary between people and cars', () => {
  assert.ok(Object.isFrozen(COLLISION))
  assert.deepEqual(COLLISION, { vehicleOnVehicle: false, ragdoll: false, combat: false, furniture: 'sensor', peopleAndCars: 'sanctuary' })
  assert.equal(COLLISION.vehicleOnVehicle, false)
  assert.equal(COLLISION.ragdoll, false)
  assert.equal(COLLISION.combat, false)
  assert.throws(() => { (COLLISION as { combat: boolean }).combat = true }, TypeError)
  assert.ok(Object.isFrozen(GROUP))
})

test('the ragdoll stays unwired: no runtime file outside its two sources imports or names it', () => {
  const sources = runtimeSources()
  assert.ok(sources.length > 50, `${sources.length} runtime sources read`)
  for (const [name, text] of sources) {
    if (RAGDOLL_FILES.includes(name)) continue
    // No import specifier reaches either ragdoll source from anywhere, the policy file included.
    for (const m of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1] ?? m[2]
      assert.doesNotMatch(spec, /ragdoll/i, `${name} imports ${spec}`)
    }
    // The policy file names the reserved bit (GROUP.ragdoll, COLLISION.ragdoll); no other code does.
    if (name === POLICY_FILE) continue
    const m = code(text).match(/ragdoll/i)
    assert.equal(m, null, `${name} names the ragdoll in its code`)
  }
  for (const f of REALM_FILES) {
    const text = readFileSync(join(SRC, f), 'utf8')
    assert.doesNotMatch(text, /ragdoll/i, `${f} mentions the ragdoll`)
  }
  assert.equal(code("import { x } from './a.ts' // ragdoll\n/* ragdoll */ const y = 1").match(/ragdoll/), null, 'comments are stripped')
  assert.ok(code("const z = 'ragdoll'").match(/ragdoll/), 'a string is caught')
})

test('a vehicle is not a cause the ragdoll accepts (restated as policy)', () => {
  assert.ok(Object.isFrozen(PERTURBATION_CAUSES))
  assert.ok(!(PERTURBATION_CAUSES as readonly string[]).includes('vehicle'))
  assert.ok(PERTURBATION_CAUSES.length > 0)
})

test('the group arithmetic: Rapier packing, the reserved ragdoll bit read from ragdollRig.ts, disjoint bits', () => {
  assert.equal(interactionGroups(0x0004, 0xffff & ~0x0004), (0x0004 << 16) | 0xfffb)
  assert.equal(interactionGroups(0xffff, 0xffff), 0xffffffff, 'a u32, never a negative number')
  assert.equal(interactionGroups(0x10002, 0x1fffd), 0x0002fffd, 'each word is 16 bits')
  assert.equal(ALL_GROUPS, 0xffff)

  const rig = readFileSync(join(SRC, '03_Spawn_Agents/ragdollRig.ts'), 'utf8')
  const m = rig.match(/RAGDOLL_GROUP\s*=\s*(0x[0-9a-f]+)/i)
  assert.ok(m, 'ragdollRig.ts declares RAGDOLL_GROUP as a hex literal')
  assert.equal(GROUP.ragdoll, Number(m![1]), 'the bit table reserves the bit the rig uses')
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
  assert.equal(meets(ragdoll, VEHICLE_CHASSIS_GROUPS), true, 'a rig segment would meet a chassis, as it meets the world (it is never built in the realm)')
})
