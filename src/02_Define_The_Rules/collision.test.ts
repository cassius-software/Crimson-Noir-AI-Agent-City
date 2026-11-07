// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
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
import {
  ACTORS, ALL_GROUPS, AVATAR_GROUPS, canCollide, COLLIDERS, COLLISION, DEFAULT_GROUPS, GROUP, interactionGroups, LAYER, RAGDOLL_GROUPS, rapierContact, rapierPairs,
  ROBOT_GROUPS, SOLID_WORLD, VEHICLE_CHASSIS_GROUPS, WALL_CONTACT, WHEEL_RAY_GROUPS,
} from './collision.ts'
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
    // A `nix build` run inside src/ leaves its result link here (tools/license/headers.mjs nixLeftover): not source.
    if (name === 'result' || name.startsWith('result-') || name === '.direnv') continue
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
  assert.deepEqual(COLLISION, { vehicleOnVehicle: false, ragdoll: true, combat: false, furniture: 'sensor', peopleAndCars: 'sanctuary', avatarThroughCars: true, surfaceRail: false })
  assert.equal(COLLISION.surfaceRail, false)
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
  const packed = rig.match(/const GROUPS = \(RAGDOLL_GROUP << 16\) \| \(0xffff & ~\(RAGDOLL_GROUP \| (0x[0-9a-f]+) \| (0x[0-9a-f]+)\)\)/i)
  assert.ok(packed, 'the rig packs (membership << 16) | filter, filtering out itself and two more bits')
  assert.deepEqual(new Set([Number(packed![1]), Number(packed![2])]), new Set([GROUP.vehicle, GROUP.query]), 'the two bits are the chassis and the wheel ray')
  assert.equal((GROUP.ragdoll << 16) | (0xffff & ~(GROUP.ragdoll | Number(packed![1]) | Number(packed![2]))), RAGDOLL_GROUPS, 'the rig\'s literal is the bit table\'s RAGDOLL_GROUPS')
  // A ragdoll is out of the vehicle layer: a chassis and a wheel ray have no bit a segment lets in, in either direction.
  assert.equal(RAGDOLL_GROUPS, (0x0004 << 16) | (0xffff & ~(0x0004 | 0x0002 | 0x0001)))
  assert.equal(RAGDOLL_GROUPS, 0x0004fff8)
  const pairs = (a: number, b: number): boolean => ((a >>> 16) & (b & 0xffff)) !== 0 && ((b >>> 16) & (a & 0xffff)) !== 0
  assert.equal(pairs(RAGDOLL_GROUPS, VEHICLE_CHASSIS_GROUPS), false, 'a segment never meets a chassis')
  assert.equal(pairs(RAGDOLL_GROUPS, WHEEL_RAY_GROUPS), false, 'a wheel ray never finds a segment')
  assert.equal(pairs(RAGDOLL_GROUPS, RAGDOLL_GROUPS), false, 'segments never meet each other')
  assert.equal(pairs(RAGDOLL_GROUPS, AVATAR_GROUPS), false, 'the avatar passes through a rig')
  assert.equal(pairs(RAGDOLL_GROUPS, interactionGroups(0xffff, 0xffff)), true, 'the ground and the buildings (default groups) hold a segment up')

  assert.equal(GROUP.vehicle & GROUP.ragdoll, 0)
  assert.equal(GROUP.query & GROUP.vehicle, 0)
  assert.equal(GROUP.query & GROUP.ragdoll, 0)

  assert.equal(VEHICLE_CHASSIS_GROUPS, 0x0002fffd)
  assert.equal(WHEEL_RAY_GROUPS, 0x0001fffd)
  // Rapier's rule, spelled out: a and b interact iff ((a >> 16) & b) != 0 and ((b >> 16) & a) != 0.
  const meets = (a: number, b: number) => ((a >>> 16) & b & 0xffff) !== 0 && ((b >>> 16) & a & 0xffff) !== 0
  const DEFAULT = interactionGroups(ALL_GROUPS, ALL_GROUPS)
  assert.equal(meets(VEHICLE_CHASSIS_GROUPS, VEHICLE_CHASSIS_GROUPS), false, 'chassis vs chassis: no pair')
  assert.equal(meets(VEHICLE_CHASSIS_GROUPS, DEFAULT), true, 'chassis vs ground, building: solid')
  assert.equal(meets(WHEEL_RAY_GROUPS, VEHICLE_CHASSIS_GROUPS), false, 'a wheel ray never finds a chassis')
  assert.equal(meets(WHEEL_RAY_GROUPS, DEFAULT), true, 'a wheel ray finds the road')
  assert.equal(meets(DEFAULT, VEHICLE_CHASSIS_GROUPS), true, 'the obstacle rays (default groups) still find a chassis')
  const ragdoll = interactionGroups(GROUP.ragdoll, ALL_GROUPS & ~GROUP.ragdoll)
  assert.equal(meets(ragdoll, VEHICLE_CHASSIS_GROUPS), true, 'a rig segment meets a chassis as it meets the world: the Sanctuary stands between them')
  assert.equal(meets(ragdoll, DEFAULT), true, 'a rig segment stands on the ground')
  assert.equal(meets(ragdoll, ragdoll), false, 'segments never meet each other')
  assert.equal(AVATAR_GROUPS, 0xfffffff9)
  assert.equal(meets(AVATAR_GROUPS, ragdoll), false, 'the avatar walks through a promoted person (the ghost-mode law)')
  assert.equal(meets(AVATAR_GROUPS, VEHICLE_CHASSIS_GROUPS), false, 'and through a car, parked or rolling: no impulse either way')
  assert.equal(meets(AVATAR_GROUPS, WHEEL_RAY_GROUPS), true, 'a wheel ray still sees the capsule by groups (the EXCLUDE_KINEMATIC flag keeps it off people)')
  assert.equal(meets(AVATAR_GROUPS, DEFAULT), true, 'and to the ground and the buildings')
  assert.equal(meets(WHEEL_RAY_GROUPS, ragdoll), true, 'a wheel ray finds a solid segment (a sensor one it excludes by flag, as it does the avatar)')
})

test('no surface rail: every train of the track network rides the elevated deck, and the Ring-0 craft floor is that deck', async () => {
  const { buildTrackNetwork, poseAt, TRACKS } = await import('../06_Make_Decisions/tracks.ts')
  const { CRAFT } = await import('./ring0.ts')
  assert.equal(COLLISION.surfaceRail, false)
  // A deck no car, bus or person on the street can reach (a car's roof is under 2 m; a person's reach under 2.5 m).
  assert.ok(TRACKS.train.deck >= 6, `deck ${TRACKS.train.deck} m`)
  assert.equal(CRAFT.floor[CRAFT.kinds.indexOf('train')], TRACKS.train.deck, 'the audit halts the realm below the deck')
  for (const seed of [1337, 7]) {
    const trains = buildTrackNetwork(seed).tracks.filter((t) => t.kind === 'train')
    assert.ok(trains.length > 0)
    for (const t of trains) {
      for (let s = 0; s < t.length; s += 2) assert.ok(poseAt(t, s).y >= TRACKS.train.deck - 1e-9, `train ${t.id} at s=${s}`)
    }
  }
  // Every kind of track is one of these five: nothing runs at street level besides the cars on their lanes. The ferries
  // sail at the water's level, beyond the seawall: no corner of a hull, at any heading, reaches the wall.
  const { LAKE } = await import('../01_Initialize_World/city.ts')
  const network = buildTrackNetwork(1337)
  const kinds = new Set(network.tracks.map((t) => t.kind))
  assert.deepEqual([...kinds].sort(), ['car', 'drone', 'ferry', 'plane', 'train'])
  const reach = Math.hypot(TRACKS.ferry.halfLength, TRACKS.ferry.halfBeam)
  for (const t of network.tracks.filter((k) => k.kind === 'ferry')) {
    for (let s = 0; s < t.length; s += 2) assert.ok(poseAt(t, s).z - reach > LAKE.shore + LAKE.wall.thickness, `ferry ${t.id} at s=${s} is on the lake`)
  }
})

test('the layer table: six one-bit layers, the solid world and the actors, frozen', () => {
  assert.ok(Object.isFrozen(LAYER))
  const bits = [LAYER.terrain, LAYER.structure, LAYER.player, LAYER.agent, LAYER.vehicle, LAYER.prop]
  assert.equal(LAYER.none, 0)
  for (const b of bits) assert.ok(b > 0 && (b & (b - 1)) === 0, `${b} is one bit`)
  assert.equal(new Set(bits).size, 6, 'distinct bits')
  assert.equal(SOLID_WORLD, LAYER.terrain | LAYER.structure)
  assert.equal(ACTORS, LAYER.player | LAYER.agent | LAYER.vehicle)
  assert.equal(SOLID_WORLD & ACTORS, 0)
  assert.equal((SOLID_WORLD | ACTORS) & LAYER.prop, 0, 'a prop is neither world nor actor')
})

test('the one rule, branchless: an actor meets the solid world and nothing else; the answer is every bit or none', () => {
  const layers = Object.values(LAYER)
  for (const a of layers) for (const b of layers) {
    const r = canCollide(a, b)
    assert.ok(r === -1 || r === 0, `canCollide(${a}, ${b}) = ${r}`)
    assert.equal(r, canCollide(b, a), 'symmetric')
    const actor = (l: number) => (l & ACTORS) !== 0, solid = (l: number) => (l & SOLID_WORLD) !== 0
    assert.equal(r === -1, (actor(a) && solid(b)) || (actor(b) && solid(a)), `canCollide(${a}, ${b})`)
  }
  // Spelled out: the pairs the 14A rule names.
  assert.equal(canCollide(LAYER.player, LAYER.terrain), -1)
  assert.equal(canCollide(LAYER.player, LAYER.structure), -1)
  assert.equal(canCollide(LAYER.vehicle, LAYER.terrain), -1)
  assert.equal(canCollide(LAYER.vehicle, LAYER.structure), -1)
  assert.equal(canCollide(LAYER.agent, LAYER.terrain), -1, 'a fallen person lies on the ground')
  assert.equal(canCollide(LAYER.agent, LAYER.structure), -1)
  assert.equal(canCollide(LAYER.player, LAYER.agent), 0, 'nobody is shoved')
  assert.equal(canCollide(LAYER.player, LAYER.vehicle), 0, 'the avatar walks through a car')
  assert.equal(canCollide(LAYER.player, LAYER.player), 0, 'players walk through players')
  assert.equal(canCollide(LAYER.vehicle, LAYER.vehicle), 0, 'cars pass through cars')
  assert.equal(canCollide(LAYER.vehicle, LAYER.agent), 0, 'a car never reaches a fallen person or a robot')
  assert.equal(canCollide(LAYER.agent, LAYER.agent), 0)
  for (const l of Object.values(LAYER)) assert.equal(canCollide(LAYER.prop, l), 0, 'a lamp stops nobody')
  assert.equal(canCollide(LAYER.terrain, LAYER.structure), 0, 'the world does not meet itself')
  assert.equal(canCollide(LAYER.none, LAYER.terrain), 0)
  // A mask of layers answers for any of them.
  assert.equal(canCollide(LAYER.player | LAYER.vehicle, LAYER.structure), -1)
  assert.equal(canCollide(ACTORS, ACTORS), 0)
  assert.equal(canCollide(ACTORS, SOLID_WORLD), -1)
  // Every bit set: usable as a mask over a 32-bit lane.
  assert.equal(canCollide(LAYER.vehicle, LAYER.structure) & 0x1234, 0x1234)
  assert.equal(canCollide(LAYER.vehicle, LAYER.vehicle) & 0x1234, 0)
})

test('the words the realm builds with say what the rule says, pair by pair: Rapier\'s pairing, sensors and body kinds against canCollide', () => {
  assert.ok(Object.isFrozen(COLLIDERS))
  const names = Object.keys(COLLIDERS) as (keyof typeof COLLIDERS)[]
  assert.deepEqual(names, ['ground', 'building', 'avatar', 'rig', 'robot', 'chassis', 'furniture'])
  for (const a of names) for (const b of names) {
    const A = COLLIDERS[a], B = COLLIDERS[b]
    assert.equal(rapierContact(A, B), canCollide(A.layer, B.layer) === -1, `${a} vs ${b}: Rapier ${rapierContact(A, B)}, the rule ${canCollide(A.layer, B.layer)}`)
  }
  // The words each class is built with are the ones the realm's modules use.
  assert.equal(COLLIDERS.chassis.groups, VEHICLE_CHASSIS_GROUPS)
  assert.equal(COLLIDERS.avatar.groups, AVATAR_GROUPS)
  assert.equal(COLLIDERS.rig.groups, RAGDOLL_GROUPS)
  assert.equal(COLLIDERS.robot.groups, ROBOT_GROUPS)
  assert.equal(COLLIDERS.ground.groups, DEFAULT_GROUPS)
  assert.equal(COLLIDERS.building.groups, DEFAULT_GROUPS)
  assert.equal(COLLIDERS.furniture.groups, DEFAULT_GROUPS)
  assert.equal(COLLIDERS.furniture.sensor, true)
  assert.equal(DEFAULT_GROUPS, 0xffffffff)
  assert.equal(rapierPairs(VEHICLE_CHASSIS_GROUPS, VEHICLE_CHASSIS_GROUPS), false)
  assert.equal(rapierPairs(VEHICLE_CHASSIS_GROUPS, DEFAULT_GROUPS), true)
  // The realm's sources carry those words (read, not imported: three of them load Rapier).
  const src = (f: string) => readFileSync(join(SRC, f), 'utf8')
  assert.match(src('07_Execute_Actions/carRig.ts'), /setCollisionGroups\(VEHICLE_CHASSIS_GROUPS\)/)
  assert.match(src('07_Execute_Actions/player.ts'), /capsule\(HALF_HEIGHT, RADIUS\)\.setCollisionGroups\(AVATAR_GROUPS\)/)
  assert.match(src('07_Execute_Actions/articulated.ts'), /setCollisionGroups\(ROBOT_GROUPS\)/)
  assert.match(src('07_Execute_Actions/physics.ts'), /\.setSensor\(true\)/, 'furniture is sensors')
  assert.doesNotMatch(src('07_Execute_Actions/physics.ts'), /setCollisionGroups/, 'the ground and the buildings keep the default words')
  // Two kinematic bodies: Rapier solves nothing between them, and the character controller is told to pass them too.
  assert.match(src('07_Execute_Actions/player.ts'), /const PASS_VEHICLES = SOLIDS \| RAPIER\.QueryFilterFlags\.EXCLUDE_DYNAMIC \| RAPIER\.QueryFilterFlags\.EXCLUDE_KINEMATIC/)
})

test('wall contact: a dead stop and a slide on every chassis, no damage model anywhere', () => {
  assert.ok(Object.isFrozen(WALL_CONTACT))
  // Zero so a car rebuilt from a room correction leaves a wall on the room's own path (mirror.node.test.ts).
  assert.equal(WALL_CONTACT.restitution, 0, 'a bounce would carry solver state a rebuild cannot copy')
  assert.ok(WALL_CONTACT.friction > 0 && WALL_CONTACT.friction <= 1)
  const rig = readFileSync(join(SRC, '07_Execute_Actions/carRig.ts'), 'utf8')
  assert.match(rig, /setFriction\(WALL_CONTACT\.friction\)\.setRestitution\(WALL_CONTACT\.restitution\)/)
  // Nothing in the realm models harm to a vehicle or a structure: no health, no damage, no wreck, no fire, no explosion.
  for (const [name, text] of runtimeSources()) {
    if (!/^07_Execute_Actions\/(vehicles|carRig|car|physics|simCore|fleetView|craftView|trackFleet)\.ts$/.test(name) && !/^02_Define_The_Rules\//.test(name)) continue
    assert.doesNotMatch(code(text), /\b(damage|health|hitpoints|wreck|crumple|explod|explosion|on fire|catch(es)? fire)\b/i, `${name} models harm`)
  }
})
