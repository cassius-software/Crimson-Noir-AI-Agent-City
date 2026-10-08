// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the character customizer's wiring (Phase 9.1): the crowd carries one look word per
 * agent in a page-only storage attribute (crowd.look) that every body material reads in both passes, whose bits stand
 * in for the hashed pieces, proportions and colour slots, and whose body bits the page's cull reads for the mesh to
 * draw; the engine writes the word the way it writes the dissolve amounts and reads it back (setLook, lookOf); the
 * host keeps the player's look under a key of its own, validated on the way in, and wears it on the player's body from
 * the start; the card is reachable from Wren's chip and touches nothing but the wardrobe model; and nothing of it
 * crosses to the physics realm.
 * What breaks if it is removed? A later edit could bind the word in a simulation pass, write it past the agent's slot,
 * drop the shadow pass's varyings (a shadow dressed differently), or keep a look the wardrobe refuses.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { InstancedMesh, MeshStandardNodeMaterial } from 'three/webgpu'
import { LOOK_NONE, LOOK_PRESETS, lookFromSeed, packLook, validateLook, type Look } from '../03_Spawn_Agents/look.ts'
import { LOOK_KEY, clearLook, loadLook, saveLook } from '../05_Observe_Environment/lookStore.ts'
import { PROFILE_KEY, type ProfileStore } from '../05_Observe_Environment/profile.ts'

// Vite's `?raw` import, for Node (crowdCompute.test.ts's hook): crowd.ts imports the crowd's WGSL that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { CrowdView } = await import('../03_Spawn_Agents/crowd.ts')
const { PASS_BINDINGS, SIM_PASSES } = await import('../03_Spawn_Agents/crowdCompute.ts')

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from)
  assert.ok(a >= 0, `missing ${from}`)
  const b = src.indexOf(to, a)
  assert.ok(b > a, `missing ${to} after ${from}`)
  return src.slice(a, b)
}
const before = (s: string, first: string, second: string, why: string) => {
  const a = s.indexOf(first), b = s.indexOf(second)
  assert.ok(a >= 0, `missing ${first}`)
  assert.ok(b >= 0, `missing ${second}`)
  assert.ok(a < b, why)
}

type N = { getChildren?: () => Iterable<unknown>; name?: unknown; varying?: unknown }
const materialOf = (mesh: InstancedMesh): MeshStandardNodeMaterial => mesh.material as MeshStandardNodeMaterial
/** Every node `root` reads from, itself included (ghost.test.ts's walk). */
const reach = (root: unknown): Set<N> => {
  const seen = new Set<N>()
  const visit = (n: unknown) => {
    if (!n || typeof n !== 'object' || seen.has(n as N)) return
    seen.add(n as N)
    for (const c of (n as N).getChildren?.() ?? []) visit(c)
  }
  visit(root)
  return seen
}

/** A Map-backed Web Storage, like profile.test.ts's. */
const mapStore = (): ProfileStore & { map: Map<string, string> } => {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v) }, removeItem: (k) => { map.delete(k) } }
}

test('the crowd: one look word per agent in a storage attribute named crowd.look, zero (as hashed) at boot, read by every body material in both passes', () => {
  const view = new CrowdView(64)
  assert.equal(view.look.name, 'crowd.look')
  assert.equal(view.look.count, 64)
  assert.equal(view.look.itemSize, 1)
  assert.ok(view.look.array instanceof Uint32Array)
  assert.ok([...(view.look.array as Uint32Array)].every((w) => w === LOOK_NONE), 'everyone dressed by the hash at boot')
  assert.equal(view.meshes.length, 8)
  for (const mesh of view.meshes) {
    const m = materialOf(mesh)
    // The pose is a Fn, built at compile time (the storage read inside it is pinned below by text); the colour graph is
    // built now and reads the word through the two varyings the pose writes, in both passes.
    assert.ok(m.positionNode && m.castShadowPositionNode, `${mesh.name}: posed for the eye and the shadow`)
    const varyings = [...reach(m.colorNode)].filter((n) => n.varying === true).map((n) => n.name)
    assert.ok(varyings.includes('vAgentLookLo') && varyings.includes('vAgentLookHi'), `${mesh.name}: the colour reads the word's halves (${varyings.join(', ')})`)
  }
})

test('crowd.ts: the word overrides the hashed mask, height and build in posed(), rides two varyings to the fragment, and picks each colour slot there', () => {
  const crowd = read('../03_Spawn_Agents/crowd.ts')
  assert.match(crowd, /look: storage\(view\.look, 'uint', agentCount\)\.toReadOnly\(\)/)
  const posed = between(crowd, 'const posed = (eye: boolean) =>', 'm.positionNode = posed(true)')
  assert.match(posed, /const word = b\.look\.element\(agentIndex\)/)
  assert.match(posed, /const custom = word\.bitAnd\(uint\(1\)\)\.equal\(uint\(1\)\)/)
  assert.match(posed, /const mask = select\(custom, float\(word\.shiftRight\(uint\(2\)\)\.bitAnd\(uint\(62\)\)\), hashedMask\)/, 'the pieces where agentXform tests them')
  assert.match(posed, /const height = select\(custom, stepOf\('height'\)\.mul\(heightScale\.range\)\.add\(heightScale\.base\), hashedHeight\)/)
  assert.match(posed, /const width = select\(custom, stepOf\('build'\)\.mul\(LOOK_SCALE\.build\.range\)\.add\(LOOK_SCALE\.build\.base\), hashedWidth\)/)
  assert.match(posed, /const shape = vec4\(height, width, mask, h\(8\)\)/)
  before(posed, "vLookLo.assign(float(word.bitAnd(uint(0xffff))))", 'if (!eye) return body', 'the shadow pass writes the low half too')
  before(posed, "vLookHi.assign(float(word.shiftRight(uint(16))))", 'if (!eye) return body', 'and the high half')
  const fragment = between(crowd, 'm.castShadowPositionNode = posed(false)', 'applyCodeDissolve(m, vDissolve, feet, PEOPLE_DISSOLVE_INK)')
  assert.match(fragment, /const word = uint\(vLookHi\.add\(0\.5\)\)\.shiftLeft\(uint\(16\)\)\.bitOr\(uint\(vLookLo\.add\(0\.5\)\)\)/, 'the word whole again')
  assert.match(fragment, /const field = \(s: LookSlot\): U1 => word\.shiftRight\(uint\(LOOK_FIELD\[s\]\[0\]\)\)\.bitAnd\(uint\(\(1 << LOOK_FIELD\[s\]\[1\]\) - 1\)\)/, 'each slot from look.ts\'s layout')
  for (const slot of ['skin', 'hairColour', 'top', 'bottom', 'shirt', 'shoes']) assert.ok(fragment.includes(`field('${slot}')`), `${slot} is read`)
  for (const line of [
    'const wornSkin = select(custom, ownSkin, skin)', 'const wornHair = select(custom, ownHair, hair)',
    'top = select(custom, ownTop, top)', 'bottom = select(custom, ownBottom, bottom)',
    'shirt = select(custom, ownShirt, shirt)', 'shoes = select(custom, ownShoes, shoes)',
  ]) assert.ok(fragment.includes(line), line)
  assert.match(fragment, /const outfit = WARDROBE\.outfits\[variant\]/, 'this body\'s cloths, from the same catalogue')
  // The tie, the bag and the hose stay hashed (the word has no room for them).
  assert.match(fragment, /const accent = variant === 0 \? pick\(PALETTE\.ties, h\(5\)\) : shirt/)
  assert.match(fragment, /pick\(PALETTE\.bags, h\(12\)\)/)
  assert.match(fragment, /const legwear = variant === 3 \? mix\(wornSkin, vec3\(0\.08, 0\.07, 0\.07\), step\(0\.55, h\(11\)\)\) : bottom/)
  assert.match(fragment, /const slots: V3\[\] = \[top, shirt, wornSkin, wornHair, bottom, shoes, accent, prop, legwear, frame\]/)
})

test('the cull reads the body out of the word (binding 13, the page\'s pass alone); no simulation pass binds it', () => {
  const wgsl = read('../03_Spawn_Agents/crowd.wgsl')
  assert.match(wgsl, /@group\(0\) @binding\(13\) var<storage, read> look: array<u32>;/)
  const cull = between(wgsl, 'fn cull(', '\n}')
  before(cull, 'let lod = select(1u, 0u, d < P.lodDistance);', 'let w = look[i];', 'after the lod')
  assert.ok(cull.includes('let variant = select(i % VARIANTS, (w >> 1u) & 3u, (w & 1u) == 1u);'), 'the hashed body unless bit 0 is set')
  before(cull, 'let variant = select(', 'let draw = lod * VARIANTS + variant;', 'before the draw list')
  assert.equal(wgsl.match(/\blook\[/g)?.length, 1, 'read once, in the cull')
  assert.deepEqual([...PASS_BINDINGS.cull], [0, 1, 10, 11, 13])
  for (const pass of SIM_PASSES) assert.ok(!PASS_BINDINGS[pass].includes(13), `${pass} never binds the look`)
  assert.match(read('../03_Spawn_Agents/crowdCull.ts'), /13: shared\.look/)
  assert.match(read('../03_Spawn_Agents/crowdCompute.ts'), /look: GPUBuffer/)
  // The air gap: the worker's crowd, the protocol, the core and the worker name none of it.
  assert.doesNotMatch(read('../03_Spawn_Agents/crowdSim.ts'), /shared\.look|\.look\b|13:/)
  for (const file of ['./simProtocol.ts', './simCore.ts', './physics.worker.ts']) {
    assert.doesNotMatch(read(file), /look\.ts|packLook|unpackLook|setLook|lookOf|crowd\.look|LOOK_/, file)
  }
})

test('engine: the look buffer is the attribute\'s (gpuBufferOf), shared with the cull; setLook writes one word at the agent\'s slot; lookOf reads the copy', () => {
  const src = read('./engine.ts')
  assert.match(src, /const crowdLook = gpuBufferOf\(gpu\.renderer, view0\.look\)/)
  const create = between(src, 'const crowd = await CrowdCull.create(gpu.device, {', '}, view0.drawTemplate, options.agents, live.cull)')
  assert.match(create, /look: crowdLook,/)
  assert.match(src, /crowdDissolve: gpuBufferOf\(gpu\.renderer, view0\.dissolve\),\n\s*crowdLook,\n/)
  assert.match(src, /private readonly crowdLook: GPUBuffer/)
  assert.match(src, /this\.lookWords = new Uint32Array\(p\.options\.agents\)/)
  const set = between(src, '  setLook(agent: number, look: Look | null): boolean {', '  lookOf(agent: number): Look | null {')
  assert.match(set, /if \(this\.halted \|\| this\.disposed\) return false/)
  assert.match(set, /if \(!Number\.isInteger\(agent\) \|\| agent < 0 \|\| agent >= this\.lookWords\.length\) return false/)
  assert.match(set, /const word = look === null \? LOOK_NONE : validateLook\(look\) === null \? -1 : packLook\(look\)/, 'null is the hash, an invalid look is refused')
  assert.match(set, /this\.gpu\.device\.queue\.writeBuffer\(this\.crowdLook, agent \* 4, this\.lookWords, agent, 1\)/, 'four bytes at the slot, the dissolve\'s path')
  assert.match(src, /lookOf\(agent: number\): Look \| null \{\n\s*if \(!Number\.isInteger\(agent\) \|\| agent < 0 \|\| agent >= this\.lookWords\.length\) return null\n\s*return unpackLook\(this\.lookWords\[agent\]\)/)
  assert.doesNotMatch(src, /sim\.send\(\{ c: 'look/, 'nothing of it is a command to the realm')
})

test('app: the player\'s look is kept under its own key, worn on agent 0 from the start, and the card is Wren\'s to open', () => {
  const app = read('../App.tsx')
  assert.match(app, /const \[look, setLook\] = useState<Look \| null>\(loadLook\)/)
  assert.match(app, /const worn = useMemo\(\(\) => look \?\? \(profile \? lookFromSeed\(profile\.seed\) : null\), \[look, profile\]\)/, 'the seed\'s look by default, one object per look')
  assert.match(app, /useEffect\(\(\) => \{ engine\?\.setLook\(PLAYER_INDEX, worn\) \}, \[engine, worn\]\)/)
  assert.match(app, /const wearLook = useCallback\(\(next: Look\) => \{ setLook\(next\); saveLook\(next\) \}, \[\]\)/)
  assert.match(app, /onLook=\{openLook\}/)
  assert.match(app, /<Customizer\n\s*visible=\{lookOpen && veilDone && !termOpen && locked === null\}/)
  assert.match(app, /engineRef\.current\?\.input\.suspend\(lookOpen \|\| termOpenRef\.current\)/, 'game input rests while the card has the pointer')
  assert.match(app, /visible=\{veilDone && hudVisible && !termOpen && !lookOpen\}/, 'Wren steps aside for the card')
  const concierge = read('./Concierge.tsx')
  assert.match(concierge, /onLook\?\(\): void/)
  assert.match(concierge, /data-concierge="chip-look"/)
  assert.match(concierge, /data-action="look"/)
  const card = read('./Customizer.tsx')
  assert.match(card, /^(?:\/\/[^\n]*\n)*\/\*\*\n \* Why does this file exist\?[\s\S]*What breaks if it is removed\?/, 'the header (after the licence lines)')
  assert.match(card, /from '\.\.\/03_Spawn_Agents\/look\.ts'/)
  assert.doesNotMatch(card, /engine\.ts|three\/|simProtocol|bridge\.ts/, 'the card knows only the wardrobe model')
  for (const name of ['LOOK_PRESETS', 'lookOptions', 'lookFromSeed', 'formatLookCode', 'parseLookCode', 'withLookSlot']) assert.ok(card.includes(name), name)
  assert.match(card, /role="dialog"/)
  // What the card prints (its string literals and JSX text) keeps the house's words.
  const printed = (card.match(/'[^'\n]*'|"[^"\n]*"|>[^<{]*</g) ?? []).join('\n')
  assert.doesNotMatch(printed, /\btarget\b|ragdoll|matrix/i)
})

test('lookStore: its own key, a look within the wardrobe round-trips, anything else reads as none, storage trouble is silent', () => {
  assert.equal(LOOK_KEY, 'civic-simulation:look:v1')
  assert.notEqual(LOOK_KEY, PROFILE_KEY)
  const store = mapStore()
  assert.equal(loadLook(store), null)
  const look = LOOK_PRESETS[4].look
  assert.equal(saveLook(look, store), true)
  assert.deepEqual(loadLook(store), look)
  assert.ok(Object.isFrozen(loadLook(store)))
  assert.equal(store.map.size, 1, 'nothing under any other key')
  assert.deepEqual(JSON.parse(store.map.get(LOOK_KEY)!), { v: 1, look })
  // Edited by hand to something the crowd does not wear: not a look.
  store.map.set(LOOK_KEY, JSON.stringify({ v: 1, look: { ...look, top: 99 } }))
  assert.equal(loadLook(store), null)
  store.map.set(LOOK_KEY, JSON.stringify({ v: 2, look }))
  assert.equal(loadLook(store), null, 'another layout is not read')
  for (const raw of ['', 'not json', '[]', '{}', JSON.stringify({ v: 1 }), 'x'.repeat(2000)]) {
    store.map.set(LOOK_KEY, raw)
    assert.equal(loadLook(store), null, raw.slice(0, 12))
  }
  assert.equal(saveLook({ ...look, body: 7 } as unknown as Look, store), false, 'an invalid look is never written')
  saveLook(look, store)
  clearLook(store)
  assert.equal(loadLook(store), null)
  assert.equal(store.map.size, 0)
  // No storage, or a storage that throws: none, and no throw.
  assert.equal(loadLook(null), null)
  assert.equal(saveLook(look, null), false)
  clearLook(null)
  const broken: ProfileStore = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') }, removeItem: () => { throw new Error('blocked') } }
  assert.equal(loadLook(broken), null)
  assert.equal(saveLook(look, broken), false)
  clearLook(broken)
  // What the engine writes for the seed's look is the packed word of a valid look (the card's default agrees with the shader's default: agent 0).
  assert.equal(validateLook(lookFromSeed(0)) !== null, true)
  assert.notEqual(packLook(lookFromSeed(0)), LOOK_NONE)
})
