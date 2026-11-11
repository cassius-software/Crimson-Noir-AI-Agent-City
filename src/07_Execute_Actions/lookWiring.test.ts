// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the character customizer's wiring (Phase 9.1): the crowd carries three words per
 * agent in page-only storage attributes (crowd.look: the body, the pieces, the colour slots, the age and the undertone;
 * crowd.figure, a pair: the eight body sliders, then the seven face sliders and the hair style) that every body
 * material reads in both passes, whose bits stand in for the hashed pieces, figure, face and colours, and whose body
 * bits the page's cull reads for the mesh to draw; the engine writes the words the way it writes the dissolve amounts
 * and reads them back (setLook, lookOf); the
 * host keeps the player's look under a key of its own, validated on the way in, and wears it on the player's body from
 * the start; the card is reachable from Sloane's chip and touches nothing but the wardrobe model; and nothing of it
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
import { LEGACY_LOOK_SLOTS, LOOK_NONE, LOOK_PRESETS, LOOK_V2_SLOTS, LOOK_V3_SLOTS, LOOK_V4_SLOTS, LOOK_WORDS, lookFromSeed, packFace, packFigure, packLook, upgradeFaceLook, upgradeFigureLook, upgradeLegacyLook, validateLook, type Look, type LookSlot } from '../03_Spawn_Agents/look.ts'
import { tattoo } from '../03_Spawn_Agents/crowdTattoo.ts'
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
const { CrowdView, FIGURE_QUADS } = await import('../03_Spawn_Agents/crowd.ts')
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

test('the crowd: a look word and four quads (the figure word, the face word, the wardrobe word, the rig slot word, then the genome\'s words 4 to 15) per agent in storage attributes named crowd.look and crowd.figure, zero (as hashed) at boot, read by every body material in both passes', () => {
  const view = new CrowdView(64)
  assert.equal(view.look.name, 'crowd.look')
  assert.equal(view.look.count, 64)
  assert.equal(view.look.itemSize, 1)
  assert.ok(view.look.array instanceof Uint32Array)
  assert.ok([...(view.look.array as Uint32Array)].every((w) => w === LOOK_NONE), 'everyone dressed by the hash at boot')
  assert.equal(view.figure.name, 'crowd.figure')
  assert.equal(FIGURE_QUADS, 4, 'sixty-four bytes a person')
  assert.equal(FIGURE_QUADS * 4, LOOK_WORDS, 'the genome\'s sixteen words but the look word, with the rig slot word in its place')
  assert.equal(view.figure.count, 64 * FIGURE_QUADS)
  assert.equal(view.figure.itemSize, 4, 'the figure, face and wardrobe words, the rig slot word and the genome\'s later words, one buffer (the vertex stage binds seven of WebGPU\'s eight)')
  assert.ok(view.figure.array instanceof Uint32Array)
  assert.equal(view.figure.array.length, 1024)
  assert.ok([...(view.figure.array as Uint32Array)].every((w) => w === 0), 'every figure, face and wardrobe the hash\'s until a look is worn')
  assert.equal(view.meshes.length, 8)
  for (const mesh of view.meshes) {
    const m = materialOf(mesh)
    // The pose is a Fn, built at compile time (the storage read inside it is pinned below by text); the colour graph is
    // built now and reads the word through the two varyings the pose writes, in both passes.
    assert.ok(m.positionNode && m.castShadowPositionNode, `${mesh.name}: posed for the eye and the shadow`)
    const varyings = [...reach(m.colorNode)].filter((n) => n.varying === true).map((n) => n.name)
    assert.ok(varyings.includes('vAgentLookLo') && varyings.includes('vAgentLookHi'), `${mesh.name}: the colour reads the word's halves (${varyings.join(', ')})`)
    assert.ok(varyings.includes('vAgentWardrobe'), `${mesh.name}: and the wardrobe word the pose resolved`)
    const genomeVarying = [...reach(m.colorNode)].find((n) => (n as { isVaryingNode?: boolean }).isVaryingNode === true && n.name === 'vAgentGenome') as { interpolationType?: string } | undefined
    assert.ok(genomeVarying, `${mesh.name}: the genome's words 4 to 7 ride a varying of their own`)
    assert.equal(genomeVarying!.interpolationType, 'flat', `${mesh.name}: flat (plain @interpolate(flat), not three's "either" sampling)`)
    const slotVarying = [...reach(m.colorNode)].find((n) => (n as { isVaryingNode?: boolean }).isVaryingNode === true && n.name === 'vAgentSlot') as { interpolationType?: string } | undefined
    assert.ok(slotVarying, `${mesh.name}: the slot rides its own varying`)
    assert.equal(slotVarying!.interpolationType, 'flat', `${mesh.name}: flat, so a band between two rings is one slot`)
  }
})

test('crowd.ts: the words override the hashed mask, figure, face and wardrobe in posed(), the look word rides two varyings and the wardrobe word a third to the fragment, which picks each colour slot, the age, the undertone and the garments\' dyes from them', () => {
  const crowd = read('../03_Spawn_Agents/crowd.ts')
  assert.match(crowd, /look: storage\(view\.look, 'uint', agentCount\)\.toReadOnly\(\)/)
  assert.match(crowd, /figure: storage\(view\.figure, 'uvec4', agentCount \* FIGURE_QUADS\)\.toReadOnly\(\)/)
  const posed = between(crowd, 'const posed = (eye: boolean) =>', 'm.positionNode = posed(true)')
  assert.match(posed, /const word = b\.look\.element\(agentIndex\)/)
  assert.match(posed, /const quad = b\.figure\.element\(agentIndex\.mul\(uint\(FIGURE_QUADS\)\)\)\n\s*const figure = quad\.x\n\s*const faceWord = quad\.y\n\s*const wardrobeWord = quad\.z/, 'the person\'s first quad')
  assert.match(posed, /const custom = word\.bitAnd\(uint\(1\)\)\.equal\(uint\(1\)\)/)
  assert.match(posed, /const mask = select\(custom, float\(word\.shiftRight\(uint\(2\)\)\.bitAnd\(uint\(46\)\)\)\.add\(ownGrooms\), hashedMask\.add\(hashedHead\)\)\.add\(features\)\.add\(wardrobePieces\)/, 'the pieces where bodyVertex tests them: the look word\'s four, the hair from the style, the face for the eye, the coat and the scarf from the wardrobe word')
  assert.match(posed, /const wardrobe = select\(custom, wardrobeWord, hashedWardrobe\)/, 'the wardrobe word worn: the look\'s or the hash\'s')
  assert.match(posed, /vWardrobe\.assign\(float\(wardrobe\.bitAnd\(uint\(0xff\)\)\.bitOr\(select\(custom, texture, uint\(0\)\)\.shiftLeft\(uint\(8\)\)\)\.bitOr\(headwear\.shiftLeft\(uint\(8 \+ HAIR_TEXTURE_BITS\)\)\)\)\)/, 'to the fragment stage, its low byte, the hair\'s paint and the headwear')
  // The style's five bits and the headwear: the skin word (the person's second quad) holds the high bits and the headwear.
  assert.match(posed, /const genomeQuad = b\.figure\.element\(agentIndex\.mul\(uint\(FIGURE_QUADS\)\)\.add\(uint\(1\)\)\)\n\s*const skinWord = genomeQuad\.x/)
  // The cut (word 5, the genome quad's second lane) drops the tie under a tieless outer layer, as lookMask does.
  assert.match(posed, /const cutNow = select\(custom, genomeQuad\.y\.shiftRight\(uint\(LOOK_FIELD\.cut\[1\]\)\)/)
  assert.match(posed, /\.bitOr\(skinWord\.shiftRight\(uint\(LOOK_FIELD_HIGH\.hairStyle!\[1\]\)\)\.bitAnd\(uint\(3\)\)\.shiftLeft\(uint\(3\)\)\)/)
  assert.match(posed, /const headwear = select\(custom, skinWord\.shiftRight\(uint\(LOOK_FIELD\.headwear\[1\]\)\)\.bitAnd\(uint\(7\)\), hashedHeadwear\)/)
  assert.match(posed, /const wears = \(piece: keyof typeof HAIR_PIECE_STYLES\) => uint\(HAIR_PIECE_STYLES\[piece\]\)\.shiftRight\(style\)\.bitAnd\(uint\(1\)\)\.equal\(uint\(1\)\)/, 'each piece from its set of styles')
  assert.match(posed, /const features = eye \? 1 << LOOK_PIECE_BIT\.face : 0/, 'the shadow map does without the features')
  assert.match(posed, /const style = faceWord\.shiftRight\(uint\(LOOK_FIELD\.hairStyle\[1\]\)\)\.bitAnd\(uint\(7\)\)/)
  assert.match(posed, /return float\(\(w === 0 \? word : w === 1 \? figure : faceWord\)\.shiftRight\(uint\(shift\)\)\.bitAnd\(uint\(\(1 << width\) - 1\)\)\)/, 'each slot from the word look.ts names')
  assert.match(posed, /const height = select\(custom, stepOf\('height'\), hashedHeight\)\.mul\(STATURE_STEP\)\.add\(WARDROBE\.stature\.min\)\.div\(HEIGHT_BASE\)/)
  assert.match(posed, /const stance = vec4\(height, mask, h\(8\), float\(quad\.w\)\)/, 'the fourth figure word is the rig slot word, in stance.w')
  assert.match(posed, /const rigBase = select\(quad\.w\.greaterThan\(uint\(0\)\), quad\.w\.sub\(uint\(1\)\), uint\(0\)\)\.mul\(uint\(RIG_WEAR\.shapes \* 2\)\)/, 'slot + 1 to the slot\'s first pose')
  assert.match(posed, /const rigA = rigAt\(rig\.x\), rigB = rigAt\(skin\.x\)/, 'each bone\'s shape')
  // A worn body writes no motion of its own: its previous position is its position, not the twin's walk.
  assert.match(posed, /positionPrevious\.assign\(select\(quad\.w\.greaterThan\(uint\(0\)\), placed, placed\.sub\(vec3\(motion\.x, 0, motion\.y\)\.mul\(this\.frameSeconds\)\)\)\)/, 'a rig wearer is sharp')
  assert.match(posed, /const morphA = vec4\(slider\('mass'\), slider\('muscle'\), slider\('shoulders'\), slider\('hips'\)\)/)
  assert.match(posed, /const morphB = vec4\(slider\('legs'\), slider\('posture'\), slider\('head'\), lowerCode\)/, 'morphB.w: the lower cut, 16 more under a coat (crowdBody.ts bodyGarment)')
  assert.match(posed, /faceA\.assign\(vec4\(faceStep\('brow'\), faceStep\('jaw'\), faceStep\('chin'\), faceStep\('cheek'\)\)\)/)
  assert.match(posed, /faceB\.assign\(vec4\(faceStep\('nose'\), faceStep\('eyes'\), faceStep\('lips'\), 0\)\)/)
  before(posed, "vLookLo.assign(float(word.bitAnd(uint(0xffff))))", 'if (!eye) return body', 'the shadow pass writes the low half too')
  before(posed, "vLookHi.assign(float(word.shiftRight(uint(16))))", 'if (!eye) return body', 'and the high half')
  const fragment = between(crowd, 'm.castShadowPositionNode = posed(false)', 'applyCodeDissolve(m, vDissolve, feet, PEOPLE_DISSOLVE_INK)')
  assert.match(fragment, /const word = uint\(vLookHi\.add\(0\.5\)\)\.shiftLeft\(uint\(16\)\)\.bitOr\(uint\(vLookLo\.add\(0\.5\)\)\)/, 'the word whole again')
  assert.match(fragment, /const field = \(s: LookSlot\): U1 => word\.shiftRight\(uint\(LOOK_FIELD\[s\]\[1\]\)\)\.bitAnd\(uint\(\(1 << LOOK_FIELD\[s\]\[2\]\) - 1\)\)/, 'each slot from look.ts\'s layout (its shift and width; every colour slot is in the look word)')
  for (const slot of ['skin', 'hairColour', 'top', 'bottom', 'shirt', 'shoes', 'age', 'undertone']) assert.ok(fragment.includes(`field('${slot}')`), `${slot} is read`)
  for (const line of [
    'const pickedSkin = select(custom, ownSkin, skin)', 'const pickedHair = select(custom, ownHair, hair)',
    'const toned = pickedSkin.mul(tint)', 'const greyed = mix(pickedHair, grey, smoothstep(0.5, 1, age)).toVar()',
    'const wornHair = hairPaint(greyed, wornSkin, hairTexture, curl, rig, slot, near).toVar()',
    'const skin = pick(PALETTE.monk, h(1))', 'const ownSkin = colour(PALETTE.skin, select(skinAt.lessThan(lastSkin), skinAt, lastSkin))',
    'const skinAt = field(\'skin\').bitOr(gene(LOOK_FIELD_HIGH.skin!).shiftLeft(uint(LOOK_FIELD.skin[2])))',
    'top = select(custom, ownTop, top)', 'bottom = select(custom, ownBottom, bottom)',
    'shirt = select(custom, ownShirt, shirt)', 'shoes = select(custom, ownShoes, shoes)',
  ]) assert.ok(fragment.includes(line), line)
  assert.match(fragment, /const wornSkin = mix\(marked, vec3\(dot\(marked, vec3\(0\.2126, 0\.7152, 0\.0722\)\)\), age\.mul\(0\.25\)\)/, 'the age fades the marked skin a quarter of the way to its grey')
  // The genome's second quad reaches the fragment as one flat varying, read only under a worn look; the skin word's
  // vitiligo and freckles mark the toned skin (the hash's for everyone else).
  assert.match(fragment, /const genome = varying\(b\.figure\.element\(b\.lists\.element\(instanceIndex\.add\(uint\(listBase\)\)\)\.mul\(uint\(FIGURE_QUADS\)\)\.add\(uint\(1\)\)\), 'vAgentGenome'\)\.setInterpolation\('flat'\)/)
  assert.match(fragment, /const vitiligo = select\(custom, gene\(LOOK_FIELD\.vitiligo\), /)
  assert.match(fragment, /const freckles = select\(custom, gene\(LOOK_FIELD\.freckles\), /)
  assert.match(fragment, /const marked = skinMarks\(toned, vitiligo, freckles, rig, /)
  assert.match(crowd, /monk: hex\(\[[^\]]+\]\),\n/, 'the Monk tones follow the older ones in the table (PALETTE order)')
  assert.ok(crowd.indexOf('  monk: hex(') === crowd.indexOf('  skin: hex(') + crowd.slice(crowd.indexOf('  skin: hex(')).indexOf('\n') + 1, 'monk is the very next palette after skin')
  assert.match(fragment, /const outfit = WARDROBE\.outfits\[variant\]/, 'this body\'s cloths, from the same catalogue')
  // The tie, the bag, the hose and the iris stay hashed (the words have no room for them).
  assert.match(fragment, /const accent = variant === 0 \? pick\(PALETTE\.ties, h\(5\)\) : shirt/)
  assert.match(fragment, /pick\(PALETTE\.bags, h\(12\)\)/)
  assert.match(fragment, /const hose = mix\(wornSkin, vec3\(0\.08, 0\.07, 0\.07\), step\(0\.55, h\(11\)\)\)/, 'the hose, the sock and a flat\'s glimpse of either: one link')
  assert.match(fragment, /const legwear = variant === 3 \? hose : bottom/)
  assert.match(fragment, /const iris = pick\(PALETTE\.iris, h\(LOOK_HASHED_COLOUR\.iris\)\)/)
  assert.match(fragment, /const slots: V3\[\] = \[worn, shirt, select\(turtleNeck, knitShirt, select\(watchHere, watchColour, select\(armHere, limbColour, skinShown\)\)\), hairShown, bottomShown, shoes, accent, prop, select\(booted, bootColour, select\(legHere, limbColour, legwear\)\), frame, white, iris, lip, scarf, fabric, device\]/, 'every slot, the bottom in its weave and its cut\'s lines, a watch over the wrist, a prosthetic over the hand or the bare shin and a boot over both, the headwear\'s cloth and the devices last')
  // The accessory word (word 6, the genome quad's third lane) reaches the fragment alone: posed() has no use for it, so
  // the vertex stages are as they were. The fragment decodes it as lookFromSeed draws it, from the colours' chain.
  assert.doesNotMatch(posed, /genomeQuad\.z/, 'the vertex stage never reads the accessory word')
  // Each decode whole, thresholds and pick included: a wrong odds name, a pick over the wrong length or a street that
  // wears the shop's own lines would draw a crowd lookFromSeed does not.
  for (const decode of [
    'const footwear = select(custom, gene(LOOK_FIELD.footwear), select(h(LOOK_HASHED_COLOUR.footwear).greaterThanEqual(LOOK_ODDS.footwear), streetFootwear, uint(0))).toVar()',
    'const frames = near ? select(custom, gene(LOOK_FIELD.frames), select(h(LOOK_HASHED_COLOUR.frames).greaterThanEqual(LOOK_ODDS.frames), uint(h(LOOK_HASHED_COLOUR.framesPick).mul(WARDROBE.frames.length - 1 - 0.001)).add(uint(1)), uint(0))).toVar()',
    'const watchLink = near ? h(LOOK_HASHED_COLOUR.watch) : float(0)',
    'const watch = near ? select(custom, gene(LOOK_FIELD.watch), select(watchLink.greaterThanEqual(LOOK_ODDS.watchSmart), uint(WATCH.smartwatch),\n      select(watchLink.greaterThanEqual(LOOK_ODDS.watchLeather), uint(WATCH.leather), select(watchLink.greaterThanEqual(LOOK_ODDS.watchSteel), uint(WATCH.steel), uint(WATCH.none))))).toVar()',
    'const pinLink = near ? h(LOOK_HASHED_COLOUR.lapelPin) : float(0)',
    'const lapelPin = near ? select(custom, gene(LOOK_FIELD.lapelPin), select(pinLink.greaterThanEqual(LOOK_ODDS.pinFlower), uint(LAPEL_PIN.flower),\n      select(pinLink.greaterThanEqual(LOOK_ODDS.pinBar), uint(LAPEL_PIN.bar), uint(LAPEL_PIN.none)))).toVar()',
  ]) assert.ok(fragment.includes(decode), decode)
  const decodes = between(fragment, 'const watchLink = ', '// A boot\'s shaft')
  assert.ok(!decodes.includes('WATCH.tourbillon') && !decodes.includes('LAPEL_PIN.rank'), 'the street never draws the tourbillon or the rank pin: the shop sells them')
  assert.match(fragment, /const streetFootwear = uint\(FOOTWEAR_STREET_PACKED\[variant\]\)\.shiftRight\(uint\(h\(LOOK_HASHED_COLOUR\.footwearPick\)\.mul\(8 - 0\.001\)\)\.mul\(uint\(4\)\)\)\.bitAnd\(uint\(15\)\)/, 'one of the body\'s eight street styles')
  // The shoe's style is painted over its colour, the shaft of a boot over the bare leg, the pin over the jacket's cloth
  // (one of the cut's marks, so the weave keeps off it), the watch over the left hand; frame 0 is the old black.
  assert.match(fragment, /shoes = footwearPaint\(shoeCloth, footwear, hose, footprint, near\)/)
  assert.match(fragment, /select\(pinHere, pinColour, stitched\)\)\)\)\)\)\)/, 'the pin innermost in the jacket')
  assert.match(fragment, /const cutMarks = [^\n]*\.or\(pinHere\)/, 'the pin is one of the cut\'s marks')
  assert.match(fragment, /watchHere = watch\.notEqual\(uint\(WATCH\.none\)\)\.and\(slotIs\(SLOT\.SKIN\)\)\.and\(boneIs\(BONE\.HAND_R\)\)/, 'the watch on the person\'s own left wrist')
  assert.ok(fragment.includes('watchColour = select(face, select(dial, dialColour, caseColour), strap)'), 'the watch in its own colours, not the skin\'s')
  assert.ok(fragment.includes('const limbShown = near ? limbHere.and(watchHere.not()) : limbHere'), 'a watch over a prosthetic hand keeps the skin slot\'s sheen')
  assert.ok(fragment.includes('const chrome = limbShown.and(fin(2))') && fragment.includes('select(limbShown.and(fin(1)), float(0.4), '), 'the finish where the limb shows')
  assert.ok(fragment.includes('pinHere = front.and(inV.not()).and(rest.x.sub(centre).greaterThan(0)).and(shape)'), 'the pin on the wearer\'s left, off the V, in its shape alone')
  assert.ok(fragment.includes('const pinAt = select(lapelWidth.greaterThan(0.02), vec2(side.sub(half.max(0).add(half).add(lapelWidth).mul(0.5)), rest.y.sub(1.42)), vec2(rest.x.sub(0.075), rest.y.sub(1.42)))'), 'halfway across the lapel, from the centre line where the V closes above the pin')
  // Option 0 is as before. The plain shoe sets no feature bit, so only a boot style's shaft paints the leg and a boot
  // alone takes a prosthetic shin out of its finish; black and the browline's brow fall through to the old black, and
  // only the browline steels its lower rim; the far body keeps the one black.
  assert.ok(fragment.includes('const footwearHas = (set: number) => uint(set).shiftRight(footwear).bitAnd(uint(1)).equal(uint(1))'), 'a feature is the style\'s bit in its set')
  assert.ok(fragment.includes('const booted = footwearHas(FOOTWEAR_FEATURES.shaft).and(onLegBone).and(positionGeometry.y.lessThan(bootTop)).and(slotIs(SLOT.LEGWEAR).or(ankle))'), 'only a boot style paints the leg, and only where it is bare')
  assert.ok(fragment.includes('limb(PROSTHETIC.rightLeg, PROSTHETIC.bothLegs)))).and(booted.not())'), 'a boot\'s shaft over a prosthetic shin')
  assert.ok(fragment.includes('[FRAMES.tortoiseshell, FRAMES.steel, FRAMES.goldTone, FRAMES.navy, FRAMES.burgundy, FRAMES.clear].reduceRight('), 'black and the browline\'s brow fall through')
  assert.ok(fragment.includes('others), vec3(0.05, 0.05, 0.055) as V3)'), 'frame 0 is the old black')
  assert.ok(fragment.includes('const frame = near ? select(frames.equal(uint(FRAMES.browline)).and(rest.y.lessThan(1.681)), finishOf(FRAMES.steel), byFinish) : vec3(0.05, 0.05, 0.055)'), 'only the browline steels the lower rim')
  // The shoe's paint (a module function, outside the stage's slice): the plain shoe skips it, each feature is one test of
  // the style's bit, the apron's seam goes round the whole toe box, and what it paints is what it returns.
  const shoePaint = between(crowd, 'function footwearPaint(', 'function agentBuffers(')
  assert.ok(shoePaint.includes('If(style.notEqual(uint(FOOTWEAR.plain)), () => {'), 'the plain shoe comes back as it went in')
  assert.ok(shoePaint.includes('const has = (set: number) => uint(set).shiftRight(style).bitAnd(uint(1)).equal(uint(1))'), 'the same bit test as the boot\'s')
  for (const k of ['twoTone', 'sneaker', 'loafer', 'strap', 'cap', 'wing', 'laces', 'flat']) assert.ok(shoePaint.includes(`has(F.${k})`), `the ${k} feature is drawn`)
  assert.ok(shoePaint.includes('select(has(F.loafer), thin(apron.sub(1).abs().mul(0.026), 0.003), float(0))'), 'the apron round the toe as well as the instep, on the upper alone')
  assert.ok(shoePaint.includes('  return paint(clothIn, styleIn, hoseIn, footprintIn)\n}'), 'the painted shoe is what comes back')
  assert.match(fragment, /select\(booted, bootColour, select\(inside, |select\(inside, woven\.mul\(0\.3\), select\(booted, bootColour, select\(legHere, limbColour, ankleCloth\)\)\)/, 'a boot below the shorter trousers')
  assert.match(fragment, /const faced = select\(lapel\.or\(collar\)\.or\(cuff\), select\(trimAt\.equal\(uint\(0\)\), woven, trimCloth\), woven\)/, 'the jacket or the coat in its weave, a matching trim too')
  assert.match(fragment, /const tailoredJacket = select\(inV\.or\(shirtCollar\), neckline, faced\)/, 'the shirt in the V and above the collar')
  assert.match(fragment, /const jacket = select\(vestArm\.or\(cropped\), shirt, select\(lining, /, 'the cut\'s marks over the jacket')
  // The garments: the layer owns the top's dye, the trim is matching or a cloth, the jacket's lines are cut from the rest position.
  assert.match(fragment, /const wardrobe = uint\(vWardrobe\.add\(0\.5\)\)/)
  assert.match(fragment, /const coat = at\(PALETTE\.coats, select\(custom, field\('top'\), uint\(h\(3\)\.mul\(cloth\(outfit\.top\)\.length - 0\.001\)\)\)\)/, 'the coat\'s cloth from the top\'s index, or the top\'s link over the jacket palette\'s length')
  assert.match(fragment, /const topCloth = select\(layer\.equal\(uint\(LAYER\.coat\)\), coat, top\)/)
  assert.match(fragment, /const trimCloth = select\(trimAt\.equal\(uint\(0\)\), topCloth, at\(PALETTE\.trims, trimAt\.sub\(uint\(1\)\)\)\)/)
  assert.match(fragment, /const scarf = at\(PALETTE\.scarves, select\(scarfAt\.equal\(uint\(0\)\), uint\(0\), scarfAt\.sub\(uint\(1\)\)\)\)/)
  assert.match(fragment, /const rest = positionGeometry/, 'the garment lines are cut from the rest position')
  assert.match(fragment, /const worn = select\(raisedWaist, waistBand, select\(layer\.equal\(uint\(LAYER\.shirt\)\), shirt, jacket\)\)/, 'under shirt sleeves the whole slot is the shirt\'s, but where high-waisted trousers rise over it')
})

test('crowd.ts: the near body inks its skin (crowdTattoo.ts) from genome word 7, or the street\'s draw under its flag, before the facial hair, declared once with the shared values; the studio\'s inks are lit where the ink shows; a genome word the varying does not carry is refused', () => {
  const crowd = read('../03_Spawn_Agents/crowd.ts')
  const fragment = between(crowd, 'm.castShadowPositionNode = posed(false)', 'applyCodeDissolve(m, vDissolve, feet, PEOPLE_DISSOLVE_INK)')
  const inked = 'const inked = near ? (tattoo(wornSkin, positionGeometry, rig.x, slot, select(custom, genome.w, uint(0x80000000)), uint(0), vSeed, footprint) as unknown as V4).toVar() as unknown as V4 : null'
  assert.ok(fragment.includes(inked), 'the near body\'s alone: the skin as worn, the rest point, the bone, the slot, word 7 or the street flag, no word 8 yet, the seed, the pixel\'s width')
  assert.ok(fragment.includes('facialPaint(inked ? inked.xyz : wornSkin, greyed, facialHair, rig, slot, near)'), 'the beard paints over the ink')
  before(fragment, inked, 'const skinShown = select(kippah, headCloth, facialPaint(inked ? inked.xyz : wornSkin', 'inked before the skin is shown')
  assert.ok(fragment.includes('wornSkin, ...(inked ? [inked] : []), greyed, wornHair, skinShown,'), 'declared once with the shared values, or every branch calls it again')
  assert.match(crowd, /^type V4 = Node<'vec4'>$/m)
  // wornSkin itself stays bare: the hose, the lips and the skin-matched prosthetic read it, not the ink.
  assert.ok(fragment.includes('const hose = mix(wornSkin, ') && fragment.includes('const lip = wornSkin.mul(') && fragment.includes('wornSkin.mul(0.96)'))
  // Words 4 to 7 alone ride the varying; a field of a later word cannot be read as word 7.
  assert.ok(fragment.includes('if (w < 4 || w > 7) throw new Error(`genome word ${w} is not in the fragment\'s flat varying (words 4 to 7)`)'))
  // The lit inks: after the sheen is set, before the wraps that dim and add to the emissive.
  const lit = between(fragment, 'if (inked) {', '\n    }\n')
  assert.ok(lit.includes('const inkNo = gene(LOOK_FIELD.tattooInk)'))
  assert.ok(lit.includes('const beardOver = facialHair.greaterThanEqual(uint(FACIAL_HAIR.fullBeard)).and(rest.y.greaterThan(1.548)).and(rest.z.greaterThan(-0.03))'), 'facialPaint\'s full beard\'s cover')
  assert.ok(lit.includes('const inkShown = select(custom.and(slotIs(SLOT.SKIN)).and(turtleNeck.or(watchHere).or(armHere).or(beardOver).not()), inked.w, float(0))'), 'a chosen look\'s ink, on the skin, where nothing covers it')
  assert.ok(lit.includes('const gold = select(inkNo.equal(uint(TATTOO_INK.goldLeaf)), inkShown, float(0))'))
  assert.ok(lit.includes('m.roughnessNode = mix(m.roughnessNode as F1, float(0.32), gold)') && lit.includes('m.metalnessNode = mix(m.metalnessNode as F1, float(0.7), gold)'), 'gold leaf\'s sheen')
  assert.ok(lit.includes('m.emissiveNode = vec3(0.33, 0.57, 0.48).mul(select(inkNo.equal(uint(TATTOO_INK.luminescent)), inkShown, float(0))).mul(float(1).sub(vDissolve))'), 'luminescent\'s glow, gone with the body')
  before(fragment, 'm.metalnessNode = select(chrome, float(0.85), float(0))', 'if (inked) {', 'after the sheen')
  before(fragment, 'if (inked) {', 'applyMatrixMode(m, ', 'before the rain mode dims the emissive')
  // Built: the near bodies' colour reaches the tattoo function, the far bodies' never does.
  const code = (tattoo as unknown as { code: string }).code
  const view = new CrowdView(16)
  for (const mesh of view.meshes) {
    const m = materialOf(mesh)
    const inks = (root: unknown) => [...reach(root)].some((n) => (n as { code?: unknown }).code === code)
    assert.equal(inks(m.colorNode), mesh.name.endsWith('lod0'), `${mesh.name}: the colour ${mesh.name.endsWith('lod0') ? 'inks' : 'has no ink'}`)
    // The dissolve gives every body an emissive; only the near one's carries the ink's glow.
    assert.equal(inks(m.emissiveNode), mesh.name.endsWith('lod0'), `${mesh.name}: the luminescent glow on the near body alone`)
  }
})

test('the cull reads the body out of the word (binding 13, the page\'s pass alone); no simulation pass binds it', () => {
  const wgsl = read('../03_Spawn_Agents/crowd.wgsl')
  assert.match(wgsl, /@group\(0\) @binding\(13\) var<storage, read> look: array<u32>;/)
  const cull = between(wgsl, 'fn cull(', '\n}')
  before(cull, 'let lod = select(1u, 0u, d < lodCut(P.lodDistance, rand(i, LOD_SALT)));', 'let w = look[i];', 'after the lod')
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
  // The figure and face words are the page's alone too: no pass binds them, the cull never reads them, the worker
  // never hears of them (crowd.wgsl says "face" of a pedestrian's facing, so the face word's own spellings are tested).
  assert.doesNotMatch(wgsl, /\bfigure\b|faceWord|packFace/)
  assert.doesNotMatch(read('../03_Spawn_Agents/crowdCompute.ts'), /\bfigure\b|faceWord|packFace/)
  assert.doesNotMatch(read('../03_Spawn_Agents/crowdCull.ts'), /shared\.figure|\.figure\b|figure:|crowd\.figure|faceWord|packFace/, 'the cull is never handed it (its comments may say "figure" of a hidden pedestrian)')
  assert.doesNotMatch(read('../03_Spawn_Agents/crowdSim.ts'), /shared\.figure|\.figure\b|faceWord|packFace/)
  for (const file of ['./simProtocol.ts', './simCore.ts', './physics.worker.ts']) assert.doesNotMatch(read(file), /packFigure|packFace|crowd\.figure|figureWords|faceWord/, file)
})

test('engine: the look buffer is the attribute\'s (gpuBufferOf), shared with the cull, the figure buffer (a quad per agent) beside it; setLook writes the words at the agent\'s slot; lookOf reads the copies', () => {
  const src = read('./engine.ts')
  assert.match(src, /const crowdLook = gpuBufferOf\(gpu\.renderer, view0\.look\)/)
  assert.match(src, /const crowdFigure = gpuBufferOf\(gpu\.renderer, view0\.figure\)/)
  const create = between(src, 'const crowd = await CrowdCull.create(gpu.device, {', '}, view0.drawTemplate, options.agents, live.cull)')
  assert.match(create, /look: crowdLook,/)
  assert.match(src, /crowdDissolve: gpuBufferOf\(gpu\.renderer, view0\.dissolve\),\n\s*crowdLook,\n\s*crowdFigure,\n/)
  assert.match(src, /private readonly crowdLook: GPUBuffer/)
  assert.match(src, /private readonly crowdFigure: GPUBuffer/)
  assert.match(src, /this\.lookWords = new Uint32Array\(p\.options\.agents\)/)
  assert.match(src, /this\.figureWords = new Uint32Array\(p\.options\.agents \* FIGURE_STRIDE\)/, 'the figure, face and wardrobe words, the rig slot word and the genome\'s later words per agent')
  assert.match(src, /const FIGURE_STRIDE = FIGURE_QUADS \* 4\nconst RIG_SLOT_WORD = 3\n/)
  assert.doesNotMatch(src, /figure: crowdFigure/, 'the cull is never handed the figure')
  const set = between(src, '  setLook(agent: number, look: Look | null): boolean {', '  lookOf(agent: number): Look | null {')
  assert.match(set, /if \(this\.halted \|\| this\.disposed\) return false/)
  assert.match(set, /if \(!Number\.isInteger\(agent\) \|\| agent < 0 \|\| agent >= this\.lookWords\.length\) return false/)
  assert.match(set, /const word = look === null \? LOOK_NONE : validateLook\(look\) === null \? -1 : packLook\(look\)/, 'null is the hash, an invalid look is refused')
  assert.match(set, /const genome = look === null \? null : packGenome\(look\)/, 'the hash\'s for null')
  assert.match(set, /for \(let w = 1; w < LOOK_WORDS; w\+\+\) this\.figureWords\[at \+ \(w < 4 \? w - 1 : w\)\] = genome === null \? 0 : genome\[w\]/, 'words 1 to 3 first, the rig slot word skipped, then 4 on')
  assert.match(set, /this\.gpu\.device\.queue\.writeBuffer\(this\.crowdLook, agent \* 4, this\.lookWords, agent, 1\)/, 'four bytes at the slot, the dissolve\'s path')
  assert.match(set, /this\.gpu\.device\.queue\.writeBuffer\(this\.crowdFigure, at \* 4, this\.figureWords, at, FIGURE_STRIDE\)/, 'and the record\'s sixty-four')
  assert.match(src, /const at = agent \* FIGURE_STRIDE \+ RIG_SLOT_WORD\n\s*if \(this\.figureWords\[at\] === word\) return/, 'the rig slot word at its place in the record')
  assert.match(src, /lookOf\(agent: number\): Look \| null \{\n\s*if \(!Number\.isInteger\(agent\) \|\| agent < 0 \|\| agent >= this\.lookWords\.length\) return null\n\s*const at = agent \* FIGURE_STRIDE, f = this\.figureWords\n\s*return unpackGenome\(\[this\.lookWords\[agent\], f\[at\], f\[at \+ 1\], f\[at \+ 2\], \.\.\.f\.subarray\(at \+ 4, at \+ FIGURE_STRIDE\)\]\)/)
  assert.doesNotMatch(src, /sim\.send\(\{ c: 'look/, 'nothing of it is a command to the realm')
})

test('app: the player\'s look is kept under its own key, worn on agent 0 from the start, and the card is Sloane\'s to open', () => {
  const app = read('../App.tsx')
  assert.match(app, /const \[look, setLook\] = useState<Look \| null>\(loadLook\)/)
  assert.match(app, /const worn = useMemo\(\(\) => look \?\? \(profile \? lookFromSeed\(profile\.seed\) : null\), \[look, profile\]\)/, 'the seed\'s look by default, one object per look')
  // A line tried on in a shop is worn over the look until it is bought or the shop's card closes (storeWiring.test.ts).
  assert.match(app, /useEffect\(\(\) => \{ engine\?\.setLook\(PLAYER_INDEX, trying\?\.look \?\? worn\) \}, \[engine, worn, trying\]\)/)
  assert.match(app, /const wearLook = useCallback\(\(next: Look\) => \{ setLook\(next\); saveLook\(next\) \}, \[\]\)/)
  assert.match(app, /onLook=\{openLook\}/)
  assert.match(app, /<Customizer\n\s*visible=\{lookOpen && veilDone && !termOpen && locked === null\}/)
  assert.match(app, /engineRef\.current\?\.input\.suspend\(lookOpen \|\| storeOpen !== null \|\| homeOpen !== null \|\| termOpenRef\.current\)/, 'game input rests while the card has the pointer')
  assert.match(app, /visible=\{veilDone && hudVisible && !termOpen && !lookOpen && storeOpen === null && homeOpen === null && locked === null\}/, 'Sloane steps aside for the card')
  const concierge = read('./Concierge.tsx')
  assert.match(concierge, /onLook\?\(\): void/)
  assert.match(concierge, /data-concierge="chip-look"/)
  assert.match(concierge, /data-action="look"/)
  const card = read('./Customizer.tsx')
  assert.match(card, /^(?:\/\/[^\n]*\n)*\/\*\*\n \* Why does this file exist\?[\s\S]*What breaks if it is removed\?/, 'the header (after the licence lines)')
  assert.match(card, /from '\.\.\/03_Spawn_Agents\/look\.ts'/)
  assert.doesNotMatch(card, /engine\.ts|three\/|simProtocol|bridge\.ts/, 'the card knows only the wardrobe model')
  for (const name of ['LOOK_PRESETS', 'lookOptions', 'lookFromSeed', 'formatLookCode', 'parseLookCode', 'withLookSlot', 'LOOK_BODY_SLIDERS', 'LOOK_FACE_SLIDERS', 'bodyShapeOf', 'faceShapeOf', 'silhouetteRings', 'faceRings']) assert.ok(card.includes(name), name)
  assert.match(card, /from '\.\.\/03_Spawn_Agents\/humanoid\.ts'/, 'the silhouette and the face view are the body\'s own rings')
  assert.match(card, /type="range"/, 'the sliders are sliders')
  assert.match(card, /data-row="silhouette"/)
  assert.match(card, /data-row="face"/)
  assert.match(card, /role="dialog"/)
  // The pieces (the hair's by the style, the headwear's) on the card are the shader's own mask (look.ts lookWears, hairBits).
  assert.match(card, /const wears = \(look: Look, piece: number\): boolean => lookWears\(look, piece\)/)
  assert.match(card, /data-row="face-shape"/, 'the face shapes head the face sliders')
  assert.match(card, /data-row="build"/)
  // The accessory word's rows: the pin goes with the jacket under shirt sleeves, the frames with the glasses; the
  // silhouette's rims wear the frames' finish, the black as before.
  assert.match(card, /if \(worn\.layer === LAYER\.shirt && \([^\n]*slot === 'lapelPin'\)\) return null/, 'no pin row under shirt sleeves')
  assert.match(card, /if \(slot === 'frames' && worn\.eyewear === 0\) return null/, 'no frames row without glasses')
  assert.ok(card.includes('out[SLOT.FRAME] = hex6(FRAME_FINISH[look.frames].reduce((n, c) => n * 256 + Math.round(255 * c), 0))'), 'the finish rounded to the nearest byte: the black is #0d0d0e (look.test.ts)')
  // What the card prints (its string literals and JSX text) keeps the house's words.
  const printed = (card.match(/'[^'\n]*'|"[^"\n]*"|>[^<{]*</g) ?? []).join('\n')
  assert.doesNotMatch(printed, /\btarget\b|ragdoll|matrix/i)
})

test('lookStore: its own key, a look within the wardrobe round-trips as a v5 record, a v4 record (thirty-two slots) reads as it is, a v3 record (twenty-nine slots), a v2 record (twenty) and a v1 record (fourteen) are upgraded, anything else reads as none, storage trouble is silent', () => {
  assert.equal(LOOK_KEY, 'civic-simulation:look:v1')
  assert.notEqual(LOOK_KEY, PROFILE_KEY)
  const store = mapStore()
  assert.equal(loadLook(store), null)
  const look = LOOK_PRESETS[4].look
  assert.equal(saveLook(look, store), true)
  assert.deepEqual(loadLook(store), look)
  assert.ok(Object.isFrozen(loadLook(store)))
  assert.equal(store.map.size, 1, 'nothing under any other key')
  assert.deepEqual(JSON.parse(store.map.get(LOOK_KEY)!), { v: 5, look })
  // Edited by hand to something the crowd does not wear: not a look.
  store.map.set(LOOK_KEY, JSON.stringify({ v: 5, look: { ...look, top: 99 } }))
  assert.equal(loadLook(store), null)
  store.map.set(LOOK_KEY, JSON.stringify({ v: 5, look: { ...look, vitiligo: 7 } }))
  assert.equal(loadLook(store), null, 'six vitiligo patterns')
  // A Monk tone, vitiligo and freckles round-trip.
  const marked = validateLook({ ...look, skin: 17, vitiligo: 3, freckles: 2 })!
  assert.equal(saveLook(marked, store), true)
  assert.deepEqual(loadLook(store), marked)
  // Every slot at its longest value, every tattoo zone inked with the longest numbers: the record stays far under the
  // length past which a stored value is taken for corruption (lookStore.ts RAW_MAX), so a tattooed look is kept.
  const rawMax = Number(/const RAW_MAX = (\d+)/.exec(read('../05_Observe_Environment/lookStore.ts'))![1])
  assert.equal(rawMax, 2048)
  const tattooed = validateLook({ ...LOOK_PRESETS[1].look, skin: 17, tattooHand: 64, tattooHandR: 63, tattooNeck: 62, tattooNape: 61, tattooInk: 7, footwear: 11, watch: 4 })!
  assert.ok(tattooed, 'a fully tattooed look is a look')
  assert.equal(saveLook(tattooed, store), true)
  assert.ok(store.map.get(LOOK_KEY)!.length < rawMax, `${store.map.get(LOOK_KEY)!.length} characters`)
  assert.deepEqual(loadLook(store), tattooed)
  // A look kept before the skin word (v 4, the thirty-two slots of the four words): worn as it was, no vitiligo, no freckles.
  const v4: Record<string, number> = {}
  for (const s of LOOK_V4_SLOTS) v4[s] = LOOK_PRESETS[6].look[s]
  store.map.set(LOOK_KEY, JSON.stringify({ v: 4, look: v4 }))
  assert.deepEqual(loadLook(store), { ...LOOK_PRESETS[6].look, vitiligo: 0, freckles: 0 })
  assert.deepEqual(loadLook(store), LOOK_PRESETS[6].look)
  const baseFace = { brow: 8, jaw: 8, chin: 8, cheek: 8, nose: 8, eyes: 8, lips: 8, age: 3, undertone: 0 }
  const baseWardrobe = { layer: 0, trim: 0, scarf: 0 }
  // A look kept before the layers (v 3, twenty-nine slots): worn again in its jacket, a matching trim, no scarf.
  const v3: Record<string, number> = {}
  for (const s of LOOK_V3_SLOTS) v3[s] = LOOK_PRESETS[2].look[s]
  store.map.set(LOOK_KEY, JSON.stringify({ v: 3, look: v3 }))
  assert.deepEqual(loadLook(store), upgradeFaceLook(v3))
  assert.deepEqual(loadLook(store), { ...LOOK_PRESETS[2].look, ...baseWardrobe })
  store.map.set(LOOK_KEY, JSON.stringify({ v: 3, look: { ...v3, layer: 2 } }))
  assert.equal(loadLook(store), null, 'a v3 record had no layer')
  // A look kept before the face (v 2, twenty slots): worn again with the base face.
  const v2: Record<string, number> = {}
  for (const s of LOOK_V2_SLOTS) v2[s] = s === 'hairStyle' ? 1 : LOOK_PRESETS[0].look[s as LookSlot]
  store.map.set(LOOK_KEY, JSON.stringify({ v: 2, look: v2 }))
  assert.deepEqual(loadLook(store), upgradeFigureLook(v2))
  assert.deepEqual(loadLook(store), { ...LOOK_PRESETS[0].look, ...baseFace, ...baseWardrobe, hairStyle: 1 })
  store.map.set(LOOK_KEY, JSON.stringify({ v: 2, look: { ...v2, hairStyle: 2 } }))
  assert.equal(loadLook(store), null, 'a v2 record had two hair styles')
  // A look kept before the figure (v 1, fourteen slots): worn again, its height and build carried into the sliders.
  const legacy: Record<string, number> = {}
  for (const s of LEGACY_LOOK_SLOTS) legacy[s] = s === 'height' ? 4 : s === 'build' ? 3 : LOOK_PRESETS[0].look[s as LookSlot]
  store.map.set(LOOK_KEY, JSON.stringify({ v: 1, look: legacy }))
  assert.deepEqual(loadLook(store), upgradeLegacyLook(legacy))
  assert.deepEqual(loadLook(store), { ...LOOK_PRESETS[0].look, height: 16, mass: 6, muscle: 8, shoulders: 8, hips: 8, legs: 8, posture: 8, head: 4, ...baseFace, ...baseWardrobe })
  store.map.set(LOOK_KEY, JSON.stringify({ v: 1, look: { ...legacy, top: 99 } }))
  assert.equal(loadLook(store), null, 'an old record outside the wardrobe is still none')
  store.map.set(LOOK_KEY, JSON.stringify({ v: 1, look }))
  assert.deepEqual(loadLook(store), look, 'a v1 record that already holds thirty-two slots reads as it is')
  store.map.set(LOOK_KEY, JSON.stringify({ v: 6, look }))
  assert.equal(loadLook(store), null, 'a layout from the future is not read')
  for (const raw of ['', 'not json', '[]', '{}', JSON.stringify({ v: 2 }), 'x'.repeat(3000)]) {
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
  assert.notEqual(packFigure(lookFromSeed(0)), packFigure(lookFromSeed(1)), 'the seeds differ in figure too')
  assert.notEqual(packFace(lookFromSeed(0)), packFace(lookFromSeed(1)), 'and in face')
})
