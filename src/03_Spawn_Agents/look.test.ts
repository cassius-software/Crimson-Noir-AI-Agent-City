// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The wardrobe is only closed if nothing drifts: the catalogue must be exactly the crowd's
 * palettes and pieces (crowd.ts cannot load in Node, it imports a WGSL file, so its source text is read instead),
 * the three packed words must carry every slot back out unchanged with the pieces at the crowd's own bit positions,
 * the body sliders in the figure word and the face sliders and the hair style in the face word the shader reads,
 * the validator must refuse everything that is not an index into the catalogue (and upgrade a look kept before the
 * face or before the figure existed, never drop it), a look code must survive copying and refuse corruption, every
 * preset must be wearable, and the seed path must reproduce three's hash bit for bit, the sliders' rounding and the
 * hair's split included.
 * What breaks if it is removed? A palette could grow a colour the crowd never wears, a bit could move and dress
 * agent 0 in the wrong cloth, or a returning visitor's saved look could be forgotten.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BODY_NAMES, FACE_NEUTRAL, HEIGHT_BASE, PIECE, SHAPE_NEUTRAL } from './humanoid.ts'
import {
  bodyShapeOf, buildOf, changeLook, describeLook, faceShapeNameOf, faceShapeOf, LOOK_FACE_SHAPE_SLIDERS, LOOK_FACE_SHAPES, lookFaceShape, withFaceShape, faceValue, formatLookCode, GREY_HAIR, HAIR, HAIR_PIECE_STYLES, HAIR_PIECES, HAIR_STYLES, HAIR_TEXTURE_STYLES, hairBits, HEADWEAR, heightScale, LAYER, LEGACY_LOOK_FIELD,
  LEGACY_LOOK_SLOTS, LONG_HAIR_BIT, LOOK_BODIES, LOOK_BODY_SLIDERS, LOOK_BUILD_SLIDERS, LOOK_BUILDS, LOOK_FACE_SLIDERS, LOOK_FIELD, LOOK_FIELD_HIGH, LOOK_GENOME_SLOTS, LOOK_HASH, LOOK_HASHED_COLOUR,
  LOOK_HASHED_FACE, LOOK_HASHED_HAIR_SPLIT, LOOK_HASHED_HEADWEAR, LOOK_HASHED_HEARING, LOOK_HASHED_LAYER, LOOK_HASHED_SCARF, LOOK_HASHED_SLIDER, LOOK_NONE, LOOK_ODDS, LOOK_PALETTE, LOOK_PIECE_BIT, LOOK_PRESETS,
  LOOK_SLIDER_MIDDLE, LOOK_SLOTS, LOOK_STATURE, LOOK_V2_SLOTS, LOOK_V3_SLOTS, LOOK_V4_SLOTS, LOOK_WORDS, lookBuild, lookFromSeed, lookMask, lookOptions, lookPreset, lookSize, lookSwatch, matchingSwatch,
  monkSkin, packFace, packFigure, packGenome, packLook, packWardrobe, parseLookCode, shaderHash, sliderValue, statureOf, statureStep, unpackFaceLook, unpackFigureLook, unpackGenome, unpackLegacyLook,
  unpackLook, upgradeFaceLook, upgradeFigureLook, upgradeLegacyLook, validateLook, VITILIGO, WARDROBE, wardrobeBits, WEAVE, WEAVE_STREET, WEAVE_STREET_PACKED, withBuild, withLookSlot,
  CUT, CUT_STREET, CUT_STREET_PACKED, garmentOf, LOOK_GARMENTS, lookGarment, lookWears, TIELESS_CUTS, withGarment,
  BOTTOM_CUT_STREET, BOTTOM_CUT_STREET_PACKED, LOOK_LOWER_GARMENTS, SKIRT_CUT, TROUSER_CUT, lookLowerGarment, lowerGarmentFits, lowerGarmentOf,
  FOOTWEAR, FOOTWEAR_FEATURES, FOOTWEAR_STREET, FOOTWEAR_STREET_PACKED, FRAME_FINISH, FRAMES, LAPEL_PIN, TORTOISE_LIGHT, WATCH,
  LOOK_STREET_FLAG, PROSTHETIC, SLEEVES, streetTattoos, tattooCover,
  type Look, type LookBody, type LookSlot,
} from './look.ts'
import {
  inkLine, TATTOO_BY_FAMILY, TATTOO_FAMILIES, TATTOO_FRAMES, TATTOO_HALO, TATTOO_HEAD_SPLIT, TATTOO_HEARTBEAT, TATTOO_INK, TATTOO_INKS, TATTOO_MOTIF_PACKED, TATTOO_MOTIFS,
  TATTOO_PEN, TATTOO_PICTURES, TATTOO_POINT_STARTS, TATTOO_POINT_STARTS_PACKED, TATTOO_POINTS_PACKED, TATTOO_SHOP_INKS, TATTOO_STREET_SETS, TATTOO_STREET_SETS_PACKED,
  TATTOO_STUDIO_LINES, TATTOO_TILE, TATTOO_ZONES, tattooContrast, tattooLuminance, type TattooRgb,
} from './tattoo.ts'
import { BONE } from './humanoid.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CROWD = readFileSync(join(HERE, 'crowd.ts'), 'utf8')
const BODIES: LookBody[] = [0, 1, 2, 3]

/** Every slot at option 0 for a body (valid by construction). */
const zero = (body: LookBody): Look => {
  const out: Record<string, number> = {}
  for (const s of LOOK_SLOTS) out[s] = s === 'body' ? body : 0
  return out as Look
}
const withSlot = (look: Look, slot: LookSlot, v: number): Look => ({ ...look, [slot]: v })
/** A look's four words. */
const words = (look: Look): [number, number, number, number] => [packLook(look), packFigure(look), packFace(look), packWardrobe(look)]
/** A look as it was kept before the figure: the fourteen legacy slots, with the height and build given. */
const legacyOf = (look: Look, height: number, build: number): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const s of LEGACY_LOOK_SLOTS) out[s] = s === 'height' ? height : s === 'build' ? build : look[s as LookSlot]
  return out
}
/** A look as it was kept before the face: the twenty slots of v2 (its hair style short or long). */
const v2Of = (look: Look): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const s of LOOK_V2_SLOTS) out[s] = s === 'hairStyle' ? Math.min(1, look[s]) : look[s as LookSlot]
  return out
}
/** A look as it was kept before the layers: the twenty-nine slots of v3. */
const v3Of = (look: Look): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const s of LOOK_V3_SLOTS) out[s] = look[s]
  return out
}
/** The look word of the layouts before the face: the hair style was bit 6, the legacy height and build the top bits. */
const oldWordOf = (look: Record<string, number>, slots: readonly string[]): number => {
  let word = 1
  for (const s of slots) {
    if (s === 'hairStyle') word |= look[s] << LONG_HAIR_BIT
    else if (s === 'build') word |= look[s] << LEGACY_LOOK_FIELD.build[0]
    else if (s === 'height' && slots === LEGACY_LOOK_SLOTS) word |= look[s] << LEGACY_LOOK_FIELD.height[0]
    else if (LOOK_FIELD[s as LookSlot][0] === 0) word |= look[s] << LOOK_FIELD[s as LookSlot][1]
  }
  return word >>> 0
}
/** The face slots of an upgraded look: the base face, the middle age, a neutral undertone. */
const BASE_FACE = Object.freeze({ brow: 8, jaw: 8, chin: 8, cheek: 8, nose: 8, eyes: 8, lips: 8, age: 3, undertone: 0 })
/** The wardrobe slots of an upgraded look: the jacket, a matching trim, no scarf. */
const BASE_WARDROBE = Object.freeze({ layer: 0, trim: 0, scarf: 0 })
/** The genome's later slots of a look kept before them: no vitiligo, no freckles. */
const BASE_GENOME = Object.freeze({ vitiligo: 0, freckles: 0, curl: 0, headwear: 0, headwearColour: 0, facialHair: 0, hearing: 0, prosthetic: 0, prostheticFinish: 0, topWeave: 0, bottomWeave: 0, cut: 0, bottomCut: 0, footwear: 0, frames: 0, watch: 0, lapelPin: 0, tattooHand: 0, tattooHandR: 0, tattooNeck: 0, tattooNape: 0, tattooInk: 0, sleeves: 0, tattooForearm: 0, tattooForearmR: 0 })

// --- The catalogue is the crowd's ------------------------------------------------------------------------------

test('LOOK_PALETTE is crowd.ts PALETTE verbatim: the same names, lengths and hex values, in order', () => {
  const block = CROWD.match(/const PALETTE = \{\n([\s\S]*?)\n\}/)
  assert.ok(block, 'crowd.ts PALETTE found')
  const parsed: Record<string, number[]> = {}
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*(\w+): hex\(\[([^\]]*)\]\),?$/)
    assert.ok(m, `palette line: ${line}`)
    parsed[m[1]] = m[2].split(',').map((s) => Number(s.trim()))
  }
  assert.deepEqual(Object.keys(LOOK_PALETTE), Object.keys(parsed))
  for (const name of Object.keys(parsed)) assert.deepEqual([...LOOK_PALETTE[name as keyof typeof LOOK_PALETTE]], parsed[name], name)
  assert.ok(Object.isFrozen(LOOK_PALETTE))
  for (const list of Object.values(LOOK_PALETTE)) assert.ok(Object.isFrozen(list))
})

test('the bodies, the piece bits, the grey, the hash chains, the odds, the hashed figure, face, hair, age and undertone are the crowd\'s', () => {
  assert.ok(CROWD.includes('export const VARIANT_NAMES = BODY_NAMES'), 'one list of body names')
  assert.deepEqual([...LOOK_BODIES], [...BODY_NAMES])
  assert.deepEqual(WARDROBE.bodies, LOOK_BODIES)
  assert.deepEqual(LOOK_PIECE_BIT, { tie: PIECE.TIE, bag: PIECE.BAG, cup: PIECE.CUP, longHair: PIECE.LONG_HAIR, glasses: PIECE.GLASSES, hairCap: PIECE.HAIR_CAP, bob: PIECE.BOB, bun: PIECE.BUN, face: PIECE.FACE, coat: PIECE.COAT, scarf: PIECE.SCARF, volume: PIECE.VOLUME, topBun: PIECE.TOP_BUN, ponytail: PIECE.PONYTAIL, wrap: PIECE.WRAP, turban: PIECE.TURBAN, hat: PIECE.HAT, brim: PIECE.BRIM, beard: PIECE.BEARD, aidL: PIECE.AID_L, aidR: PIECE.AID_R, coilL: PIECE.COIL_L, coilR: PIECE.COIL_R })
  assert.equal(PIECE.NONE, 0)
  assert.ok(CROWD.includes('vec3(0.6, 0.6, 0.58), step(0.9, h(9))'), 'grey hair mix')
  assert.equal(GREY_HAIR, (Math.round(0.6 * 255) << 16) | (Math.round(0.6 * 255) << 8) | Math.round(0.58 * 255))
  assert.ok(CROWD.includes(`hash(seed.add(k * ${LOOK_HASH.pieces}))`), 'vertex chain')
  assert.ok(CROWD.includes(`hash(vSeed.add(k * ${LOOK_HASH.colours}))`), 'fragment chain')
  assert.ok(CROWD.includes(`step(${LOOK_ODDS.tie}, h(1)).mul(2)`))
  assert.ok(CROWD.includes(`step(woman ? ${LOOK_ODDS.bagWoman} : ${LOOK_ODDS.bagMan}, h(2)).mul(4)`))
  assert.ok(CROWD.includes(`step(${LOOK_ODDS.cup}, h(3)).mul(8)`))
  assert.ok(CROWD.includes(`step(${LOOK_ODDS.glasses}, h(5)).mul(32)`))
  assert.ok(CROWD.includes(`step(${LOOK_ODDS.darkTrousers}, h(10))`))
  assert.ok(CROWD.includes('uint(hk.mul(list.length - 0.001))'), 'pick truncates hk * (len - 0.001)')
  // The hair: short under the long-hair odds; a woman's split link under bob is long, under bun a bob, else a bun; a
  // man's split at or past bald is bald, else long when not short. The cap goes with every style but bald.
  assert.ok(CROWD.includes('const notShort = step(LOOK_ODDS.longHair, h(4))'))
  assert.ok(CROWD.includes('const split = h(LOOK_HASHED_HAIR_SPLIT)'))
  assert.ok(CROWD.includes('? float(64).add(notShort.mul(past(LOOK_ODDS.bun)).mul(256))'), 'a woman\'s crown')
  assert.ok(CROWD.includes('? notShort.mul(past(LOOK_ODDS.bob).oneMinus()).mul(16).add(notShort.mul(past(LOOK_ODDS.bob)).mul(past(LOOK_ODDS.bun).oneMinus()).mul(128))'), 'a woman\'s length')
  assert.ok(CROWD.includes(': past(LOOK_ODDS.bald).oneMinus().mul(64)'), 'a man\'s crown')
  assert.ok(CROWD.includes(': past(LOOK_ODDS.bald).oneMinus().mul(notShort.mul(16))'), 'a man\'s length')
  // The headwear: a hijab or a head wrap for a few women, a turban, a kippah or a flat cap for a few men, on the vertex chain's next link.
  assert.equal(LOOK_HASHED_HEADWEAR, 25)
  assert.deepEqual([LOOK_ODDS.hijab, LOOK_ODDS.headWrap, LOOK_ODDS.turban, LOOK_ODDS.kippah, LOOK_ODDS.flatCap], [0.95, 0.93, 0.975, 0.965, 0.95])
  assert.ok(CROWD.includes('const wear = h(LOOK_HASHED_HEADWEAR)'))
  assert.ok(CROWD.includes('? select(odds(LOOK_ODDS.hijab), uint(HEADWEAR.hijab), select(odds(LOOK_ODDS.headWrap), uint(HEADWEAR.headWrap), uint(HEADWEAR.none)))'))
  assert.ok(CROWD.includes(': select(odds(LOOK_ODDS.turban), uint(HEADWEAR.turban), select(odds(LOOK_ODDS.kippah), uint(HEADWEAR.kippah), select(odds(LOOK_ODDS.flatCap), uint(HEADWEAR.flatCap), uint(HEADWEAR.none))))'))
  assert.ok(CROWD.includes('const curl = select(custom, gene(LOOK_FIELD.curl), uint(h(LOOK_HASHED_COLOUR.curl).mul(WARDROBE.curl.length - 1 - 0.001)).add(uint(1)))'))
  assert.ok(CROWD.includes('select(custom, gene(LOOK_FIELD.headwearColour), uint(h(LOOK_HASHED_COLOUR.headwearCloth).mul(PALETTE.headwear.length - 0.001)))'))
  assert.deepEqual([LOOK_ODDS.longHair, LOOK_ODDS.bob, LOOK_ODDS.bun, LOOK_ODDS.bald], [0.35, 0.34, 0.67, 0.96])
  assert.equal(LOOK_HASHED_HAIR_SPLIT, 22)
  // The wardrobe: the layer and the scarf on the vertex chain's next links, the trim's contrast and the cloths on the fragment chain's.
  assert.deepEqual([LOOK_HASHED_LAYER, LOOK_HASHED_SCARF], [23, 24])
  assert.deepEqual([LOOK_ODDS.shirtSleeves, LOOK_ODDS.coat, LOOK_ODDS.scarf, LOOK_ODDS.trim], [0.2, 0.85, 0.88, 0.8])
  assert.ok(CROWD.includes('const layerLink = h(LOOK_HASHED_LAYER)'))
  assert.ok(CROWD.includes('select(layerLink.lessThan(LOOK_ODDS.shirtSleeves), uint(LAYER.shirt), select(layerLink.greaterThanEqual(LOOK_ODDS.coat), uint(LAYER.coat), uint(LAYER.jacket)))'))
  assert.ok(CROWD.includes('const clothAt = (link: F1, n: number) => uint(link.mul(n - 0.001)).add(uint(1))'))
  assert.ok(CROWD.includes('select(hc(LOOK_HASHED_COLOUR.trim).greaterThanEqual(LOOK_ODDS.trim), clothAt(hc(LOOK_HASHED_COLOUR.trimCloth), PALETTE.trims.length), uint(0))'))
  assert.ok(CROWD.includes('select(h(LOOK_HASHED_SCARF).greaterThanEqual(LOOK_ODDS.scarf), clothAt(hc(LOOK_HASHED_COLOUR.scarfCloth), PALETTE.scarves.length), uint(0))'))
  assert.ok(CROWD.includes('const hc = (k: number) => hash(seed.add(k * 7.919))'), 'the colours\' chain in the vertex stage, for the cloths')
  // The hashed figure: the same links of the chain, rounded to the same steps, the stature from this body's range.
  assert.ok(CROWD.includes('const stature = woman ? LOOK_STATURE.woman : LOOK_STATURE.man'))
  assert.ok(CROWD.includes('const hashedStep = (k: number, n: number) => h(k).mul(n).add(0.5).floor()'), 'round(h * n)')
  assert.ok(CROWD.includes('const hashedHeight = hashedStep(6, stature.span).add(stature.from)'))
  assert.ok(CROWD.includes("const n = (slot === 'head' ? WARDROBE.headSteps : WARDROBE.sliderSteps) - 1"))
  assert.ok(CROWD.includes('return select(custom, stepOf(slot), hashedStep(LOOK_HASHED_SLIDER[slot], n)).div(n)'))
  assert.ok(CROWD.includes("const height = select(custom, stepOf('height'), hashedHeight).mul(STATURE_STEP).add(WARDROBE.stature.min).div(HEIGHT_BASE)"))
  assert.ok(CROWD.includes('const STATURE_STEP = (WARDROBE.stature.max - WARDROBE.stature.min) / (WARDROBE.stature.steps - 1)'))
  assert.deepEqual(Object.keys(LOOK_HASHED_SLIDER), LOOK_BODY_SLIDERS.filter((s) => s !== 'height'))
  // The hashed face: its own links, rounded to the sliders' steps, about the base face.
  assert.ok(CROWD.includes('select(custom, stepOf(slot), hashedStep(LOOK_HASHED_FACE[slot], WARDROBE.sliderSteps - 1)).sub(LOOK_SLIDER_MIDDLE.slider).div(LOOK_SLIDER_MIDDLE.slider)'))
  assert.deepEqual(Object.keys(LOOK_HASHED_FACE), [...LOOK_FACE_SLIDERS])
  assert.deepEqual(Object.values(LOOK_HASHED_FACE), [15, 16, 17, 18, 19, 20, 21])
  const links = [...Object.values(LOOK_HASHED_SLIDER), ...Object.values(LOOK_HASHED_FACE), LOOK_HASHED_HAIR_SPLIT, LOOK_HASHED_LAYER, LOOK_HASHED_SCARF]
  assert.equal(new Set(links).size, links.length, 'a link each')
  for (const k of links) assert.ok(k === 7 || k >= 9, `link ${k} is free of the pieces (1-5), the height (6) and the idle phase (8)`)
  // The hashed age, undertone and iris: the fragment chain's free links (1-6 and 9-12 are the colours).
  assert.deepEqual(LOOK_HASHED_COLOUR, { age: 7, undertone: 8, iris: 13, trim: 14, scarfCloth: 15, trimCloth: 16, vitiligo: 17, vitiligoPattern: 18, freckles: 19, frecklesDensity: 20, marks: 21, headwearCloth: 24, curl: 25, facialHair: 26, facialHairStyle: 31, prosthetic: 28, prostheticLimb: 29, prostheticFinish: 30, weave: 32, weavePick: 33, cut: 34, cutPick: 35, bottomCut: 36, bottomCutPick: 37, footwear: 38, footwearPick: 39, frames: 40, framesPick: 41, watch: 42, lapelPin: 43, tattoo: 44, tattooZones: 45, tattooFirst: 46, tattooSecond: 47, tattooInk: 48 })
  const colourLinks = [...Object.values(LOOK_HASHED_COLOUR), LOOK_HASHED_COLOUR.marks + 1, LOOK_HASHED_COLOUR.marks + 2]
  for (const k of colourLinks) assert.ok(k === 7 || k === 8 || k >= 13, `colour link ${k} is free of the colours (1-6, 9-12)`)
  assert.equal(new Set(colourLinks).size, 37, 'a link each, the marks\' offset three of them')
  // The tattoos: one person in five carries ink, on the colours' chain's links 44 to 48; its ink's thresholds.
  assert.deepEqual([LOOK_ODDS.tattoo, LOOK_ODDS.inkGrey, LOOK_ODDS.inkIndigo, LOOK_ODDS.inkRed, LOOK_ODDS.inkGreen, LOOK_ODDS.inkWhite], [0.8, 0.7, 0.84, 0.91, 0.95, 0.98])
  assert.ok(CROWD.includes('h(LOOK_HASHED_COLOUR.age).mul(WARDROBE.ageSteps - 1).add(0.5).floor()).div(WARDROBE.ageSteps - 1)'))
  // The skin word: the hashed crowd's Monk tone, its vitiligo (two in a hundred, a pattern of the six) and freckles (about one in six, a density of the three).
  assert.ok(CROWD.includes('const skin = pick(PALETTE.monk, h(1))'), 'the hashed crowd wears the Monk scale')
  assert.ok(CROWD.includes('select(h(LOOK_HASHED_COLOUR.vitiligo).greaterThanEqual(LOOK_ODDS.vitiligo), uint(h(LOOK_HASHED_COLOUR.vitiligoPattern).mul(WARDROBE.vitiligo.length - 1 - 0.001)).add(uint(1)), uint(0))'))
  assert.ok(CROWD.includes('select(h(LOOK_HASHED_COLOUR.freckles).greaterThanEqual(LOOK_ODDS.freckles), uint(h(LOOK_HASHED_COLOUR.frecklesDensity).mul(WARDROBE.freckles.length - 1 - 0.001)).add(uint(1)), uint(0))'))
  assert.ok(CROWD.includes('vec3(h(LOOK_HASHED_COLOUR.marks), h(LOOK_HASHED_COLOUR.marks + 1), h(LOOK_HASHED_COLOUR.marks + 2))'), 'where the marks fall: the person\'s own')
  assert.deepEqual([LOOK_ODDS.vitiligo, LOOK_ODDS.freckles], [0.98, 0.84])
  assert.ok(CROWD.includes('uint(h(LOOK_HASHED_COLOUR.undertone).mul(WARDROBE.undertone.length - 0.001))'))
  assert.ok(CROWD.includes('pick(PALETTE.iris, h(LOOK_HASHED_COLOUR.iris))'))
  for (const k of [1, 2, 3, 4, 5, 6, 9, 10, 11, 12]) assert.ok(CROWD.includes(`h(${k})`), `fragment link ${k} is a colour's`)
})

test('each body\'s outfit draws from the palettes crowd.ts\'s fragment branch picks for it', () => {
  const branches = [
    ['suits', 'shirts', 'ties', 'menShoes'],
    ['blazers', 'chinos', 'casualShirts', 'casualShoes'],
    ['womenBlazers', 'darkTrousers', 'blouses', 'womenShoes'],
    ['womenTops', 'skirts', 'blouses', 'womenShoes'],
  ]
  for (const b of BODIES) for (const p of branches[b]) assert.ok(CROWD.includes(`PALETTE.${p}, h(`), `${LOOK_BODIES[b]} uses ${p}`)
  assert.deepEqual(WARDROBE.outfits.map((o) => [o.top, o.bottom, o.shirt, o.shoes, o.matching]), [
    ['suits', 'suits', 'shirts', 'menShoes', true],
    ['blazers', 'chinos', 'casualShirts', 'casualShoes', false],
    ['womenBlazers', 'darkTrousers', 'blouses', 'womenShoes', true],
    ['womenTops', 'skirts', 'blouses', 'womenShoes', false],
  ])
  assert.ok(CROWD.includes('top = pick(PALETTE.suits, h(3)); bottom = top'), 'the suit\'s trousers match')
  assert.ok(CROWD.includes('bottom = mix(top, pick(PALETTE.darkTrousers, h(4)), step(0.6, h(10)))'), 'the pantsuit matches or is dark')
})

test('slot sizes: the pinned counts, every colour option a palette swatch, the piece slots on/off, the sliders\' steps, the hair styles, the undertones', () => {
  const sizes = (body: LookBody) => Object.fromEntries(LOOK_SLOTS.map((s) => [s, lookSize(body, s)]))
  const common = {
    body: 4, height: 32, mass: 16, muscle: 16, shoulders: 16, hips: 16, legs: 16, posture: 16, head: 8,
    brow: 16, jaw: 16, chin: 16, cheek: 16, nose: 16, eyes: 16, lips: 16,
    skin: 18, age: 8, undertone: 4, vitiligo: 7, freckles: 4, hairStyle: 32, curl: 13, headwear: 8, headwearColour: 8, facialHair: 7, hearing: 5, prosthetic: 7, prostheticFinish: 4, topWeave: 16, bottomWeave: 16, bottomCut: 16, hairColour: 9, tie: 2, eyewear: 2, bag: 2, cup: 2, layer: 3, cut: 16, trim: 8, scarf: 8,
    footwear: 12, frames: 8, watch: 5, lapelPin: 4,
    tattooHand: 65, tattooHandR: 65, tattooNeck: 65, tattooNape: 65, tattooInk: 8, sleeves: 2, tattooForearm: 65, tattooForearmR: 65,
  }
  assert.deepEqual(sizes(0), { ...common, top: 7, bottom: 8, shirt: 6, shoes: 3 })
  assert.deepEqual(sizes(1), { ...common, top: 7, bottom: 6, shirt: 6, shoes: 4 })
  assert.deepEqual(sizes(2), { ...common, top: 7, bottom: 4, shirt: 6, shoes: 4 })
  assert.deepEqual(sizes(3), { ...common, top: 6, bottom: 6, shirt: 6, shoes: 4 })
  for (const b of BODIES) {
    assert.deepEqual(lookOptions(b, 'hairColour').map((o) => o.hex), [...LOOK_PALETTE.hair, GREY_HAIR])
    assert.deepEqual(lookOptions(b, 'skin').map((o) => o.hex), [...LOOK_PALETTE.skin, ...LOOK_PALETTE.monk], 'the eight older tones keep their numbers; the Monk scale follows')
    assert.deepEqual(lookOptions(b, 'skin').slice(8).map((o) => o.name), ['mst-01', 'mst-02', 'mst-03', 'mst-04', 'mst-05', 'mst-06', 'mst-07', 'mst-08', 'mst-09', 'mst-10'])
    assert.deepEqual(lookOptions(b, 'vitiligo').map((o) => o.name), ['none', 'hands', 'face', 'hands and face', 'scattered', 'widespread', 'one side'])
    assert.deepEqual(lookOptions(b, 'freckles').map((o) => o.name), ['none', 'light', 'medium', 'dense'])
    const o = WARDROBE.outfits[b]
    assert.deepEqual(lookOptions(b, 'top').map((x) => x.hex), [...LOOK_PALETTE[o.top]])
    assert.deepEqual(lookOptions(b, 'top', LAYER.jacket), lookOptions(b, 'top'))
    assert.deepEqual(lookOptions(b, 'top', LAYER.shirt), lookOptions(b, 'top'), 'under shirt sleeves the jacket keeps its cloths, unseen')
    assert.deepEqual(lookOptions(b, 'top', LAYER.coat).map((x) => x.hex), LOOK_PALETTE.coats.slice(0, LOOK_PALETTE[o.top].length), 'a coat\'s cloths, as many as the jacket\'s')
    assert.deepEqual(lookOptions(b, 'layer').map((x) => x.name), ['jacket', 'shirt sleeves', 'coat'])
    assert.deepEqual(lookOptions(b, 'trim').map((x) => x.hex), [null, ...LOOK_PALETTE.trims])
    assert.equal(lookOptions(b, 'trim')[0].name, 'matching')
    assert.deepEqual(lookOptions(b, 'scarf').map((x) => x.hex), [null, ...LOOK_PALETTE.scarves])
    assert.equal(lookOptions(b, 'scarf')[0].name, 'none')
    assert.deepEqual(lookOptions(b, 'bottom').map((x) => x.hex), [...(o.matching ? [null] : []), ...LOOK_PALETTE[o.bottom]])
    assert.deepEqual(lookOptions(b, 'shirt').map((x) => x.hex), [...LOOK_PALETTE[o.shirt]])
    assert.deepEqual(lookOptions(b, 'shoes').map((x) => x.hex), [...LOOK_PALETTE[o.shoes]])
    assert.deepEqual(lookOptions(b, 'hairStyle').slice(0, 5).map((o) => o.name), ['short', 'long', 'bob', 'bun', 'bald'], 'the five older styles keep their numbers')
    assert.deepEqual(lookOptions(b, 'curl').map((o) => o.name), ['as styled', '1A', '1B', '1C', '2A', '2B', '2C', '3A', '3B', '3C', '4A', '4B', '4C'])
    assert.deepEqual(lookOptions(b, 'headwear').map((o) => o.name), ['none', 'hijab', 'turban', 'head wrap', 'kippah', 'durag', 'beanie', 'flat cap'])
    assert.deepEqual(lookOptions(b, 'headwearColour').map((o) => o.hex), [...LOOK_PALETTE.headwear])
    // The accessory word's slots: the same names on every body.
    assert.deepEqual(lookOptions(b, 'footwear').map((o) => o.name), ['plain', 'lace-up', 'cap toe', 'wingtip', 'loafer', 'buckle strap', 'two-tone', 'sneaker', 'flat', 'ankle boot', 'lace-up boot', 'knee boot'])
    assert.deepEqual(lookOptions(b, 'frames').map((o) => o.name), ['black', 'tortoiseshell', 'steel', 'gold tone', 'navy', 'burgundy', 'clear', 'browline'])
    assert.deepEqual(lookOptions(b, 'watch').map((o) => o.name), ['none', 'steel three-hand', 'tourbillon chronograph', 'leather strap', 'smartwatch'])
    assert.deepEqual(lookOptions(b, 'lapelPin').map((o) => o.name), ['none', 'rank pin', 'silver bar', 'buttonhole flower'])
    // The tattoo word's slots: every zone offers none and the sixty-four designs by id; the ink is a swatch.
    for (const s of ['tattooHand', 'tattooHandR', 'tattooNeck', 'tattooNape'] as const) assert.deepEqual(lookOptions(b, s), [{ name: 'none', hex: null }, ...TATTOO_MOTIFS.map((m) => ({ name: m.name, hex: null }))])
    assert.deepEqual(lookOptions(b, 'tattooInk'), TATTOO_INKS.map((i) => ({ name: i.name, hex: i.hex })))
    for (const s of ['tie', 'eyewear', 'bag', 'cup', 'hairStyle', 'undertone', 'layer', 'vitiligo', 'freckles', 'curl', 'headwear', 'footwear', 'frames', 'watch', 'lapelPin'] as const) {
      assert.equal(lookOptions(b, s)[0].name, s === 'hairStyle' ? 'short' : s === 'undertone' ? 'neutral' : s === 'layer' ? 'jacket' : s === 'curl' ? 'as styled' : s === 'footwear' ? 'plain' : s === 'frames' ? 'black' : 'none')
      assert.ok(lookOptions(b, s).every((x) => x.hex === null))
    }
    assert.equal(lookOptions(b, 'hairStyle').length, 32)
    assert.deepEqual(lookOptions(b, 'undertone').map((x) => x.name), ['neutral', 'warm', 'cool', 'olive'])
    for (const s of LOOK_SLOTS) for (const x of lookOptions(b, s)) assert.match(x.name, /^[\x20-\x7e]+$/, 'ASCII names')
    // The height reads in metres; the other sliders count their steps.
    assert.deepEqual([lookOptions(b, 'height')[0].name, lookOptions(b, 'height')[31].name], ['1.50 m', '2.05 m'])
    assert.deepEqual([lookOptions(b, 'mass')[0].name, lookOptions(b, 'mass')[15].name, lookOptions(b, 'head')[7].name, lookOptions(b, 'nose')[15].name, lookOptions(b, 'age')[7].name], ['1', '16', '8', '16', '8'])
  }
  assert.equal(LOOK_SLOTS.length, 57)
  assert.deepEqual(LOOK_SLOTS.slice(0, 9), ['body', ...LOOK_BODY_SLIDERS])
  assert.deepEqual(LOOK_SLOTS.slice(9, 16), [...LOOK_FACE_SLIDERS])
  assert.deepEqual(LOOK_SLOTS.slice(16, 21), ['skin', 'age', 'undertone', 'vitiligo', 'freckles'], 'the skin\'s slots together')
  assert.deepEqual(LOOK_SLOTS.slice(21, 26), ['hairStyle', 'curl', 'hairColour', 'headwear', 'headwearColour'], 'the hair\'s slots and what is worn over it together')
  assert.deepEqual(LOOK_SLOTS.slice(26, 30), ['facialHair', 'hearing', 'prosthetic', 'prostheticFinish'], 'the person\'s own: facial hair, hearing devices, a limb')
  assert.deepEqual(LOOK_SLOTS.slice(30, 49), ['layer', 'cut', 'top', 'topWeave', 'trim', 'bottomCut', 'bottom', 'bottomWeave', 'shirt', 'footwear', 'shoes', 'tie', 'scarf', 'lapelPin', 'eyewear', 'frames', 'watch', 'bag', 'cup'], 'the layer and its cut before the top it dyes, each cloth\'s weave after it, the trim after the top, the lower cut before the bottom, the shoe\'s style before its colour, the pin with the neckwear, the frames after the glasses')
  assert.deepEqual(LOOK_SLOTS.slice(49, 54), ['tattooHand', 'tattooHandR', 'tattooNeck', 'tattooNape', 'tattooInk'], 'the tattoo word\'s zones in its order, then their one ink')
  assert.deepEqual(LOOK_SLOTS.slice(54, 57), ['sleeves', 'tattooForearm', 'tattooForearmR'], 'the sleeves, then the forearms they bare')
  assert.deepEqual([...LOOK_GENOME_SLOTS], ['vitiligo', 'freckles', 'curl', 'headwear', 'headwearColour', 'facialHair', 'hearing', 'prosthetic', 'prostheticFinish', 'topWeave', 'bottomWeave', 'cut', 'bottomCut', 'footwear', 'frames', 'watch', 'lapelPin', 'tattooHand', 'tattooHandR', 'tattooNeck', 'tattooNape', 'tattooInk', 'sleeves', 'tattooForearm', 'tattooForearmR'])
  assert.deepEqual([...LOOK_V4_SLOTS], LOOK_SLOTS.filter((s) => !(LOOK_GENOME_SLOTS as readonly string[]).includes(s)))
  assert.equal(LOOK_V4_SLOTS.length, 32)
  assert.deepEqual([...LOOK_V3_SLOTS], LOOK_V4_SLOTS.filter((s) => s !== 'layer' && s !== 'trim' && s !== 'scarf'))
  assert.equal(LOOK_V3_SLOTS.length, 29)
  assert.deepEqual(LAYER, { jacket: 0, shirt: 1, coat: 2 })
  assert.deepEqual([...WARDROBE.layer], ['jacket', 'shirt sleeves', 'coat'])
  assert.deepEqual([...LOOK_V2_SLOTS], LOOK_V3_SLOTS.filter((s) => !(LOOK_FACE_SLIDERS as readonly string[]).includes(s) && s !== 'age' && s !== 'undertone'))
  assert.equal(LOOK_V2_SLOTS.length, 20)
  assert.equal(LEGACY_LOOK_SLOTS.length, 14)
  assert.deepEqual(HAIR, { short: 0, long: 1, bob: 2, bun: 3, bald: 4, afro: 8 })
  for (const [name, i] of Object.entries(HAIR)) assert.equal(HAIR_STYLES[i].name, name)
  assert.deepEqual(WARDROBE.hairStyle, HAIR_STYLES.map((h) => h.name), 'the catalogue\'s names are the styles\' own')
  assert.equal(new Set(WARDROBE.hairStyle).size, 32, 'thirty-two names, each its own')
  for (const name of ['mohawk', 'mohican']) assert.ok(!WARDROBE.hairStyle.includes(name), `a cut is named for itself, not for a people (${name})`)
  assert.equal(WARDROBE.ageSteps, 8)
  assert.ok(Object.isFrozen(WARDROBE) && Object.isFrozen(WARDROBE.outfits) && Object.isFrozen(LOOK_FIELD) && Object.isFrozen(HAIR))
})

test('lookSwatch: colours for colour slots, the jacket\'s cloth for matching trousers, the outer layer\'s for a matching trim, the coat\'s for the top under a coat, null for pieces and sliders', () => {
  const suit = zero(0)
  assert.equal(lookSwatch(suit, 'top'), LOOK_PALETTE.suits[0])
  assert.equal(lookSwatch(suit, 'bottom'), LOOK_PALETTE.suits[0], 'matching')
  assert.equal(lookSwatch(withSlot(suit, 'bottom', 3), 'bottom'), LOOK_PALETTE.suits[2])
  assert.equal(lookSwatch(withSlot(zero(2), 'bottom', 1), 'bottom'), LOOK_PALETTE.darkTrousers[0])
  // The layer: a coat's cloth on the top; matching trousers keep the jacket's cloth under it; a matching trim wears the outer layer's.
  const coated = withSlot(withSlot(suit, 'layer', LAYER.coat), 'top', 2)
  assert.equal(lookSwatch(coated, 'top'), LOOK_PALETTE.coats[2])
  assert.equal(lookSwatch(coated, 'bottom'), LOOK_PALETTE.suits[2], 'the trousers match the jacket, not the coat')
  assert.equal(matchingSwatch(coated, 'bottom'), LOOK_PALETTE.suits[2])
  assert.equal(lookSwatch(coated, 'trim'), LOOK_PALETTE.coats[2], 'the trim matches the coat')
  assert.equal(matchingSwatch(coated, 'trim'), LOOK_PALETTE.coats[2])
  assert.equal(lookSwatch(suit, 'trim'), LOOK_PALETTE.suits[0])
  assert.equal(lookSwatch(withSlot(suit, 'trim', 3), 'trim'), LOOK_PALETTE.trims[2])
  assert.equal(lookSwatch(withSlot(suit, 'layer', LAYER.shirt), 'top'), LOOK_PALETTE.suits[0], 'the jacket\'s cloth, kept while it is off')
  assert.equal(lookSwatch(suit, 'scarf'), null, 'no scarf')
  assert.equal(lookSwatch(withSlot(suit, 'scarf', 1), 'scarf'), LOOK_PALETTE.scarves[0])
  assert.equal(lookSwatch(suit, 'layer'), null)
  assert.equal(matchingSwatch(zero(1), 'bottom'), null, 'chinos never match')
  assert.equal(lookSwatch(withSlot(suit, 'hairColour', 8), 'hairColour'), GREY_HAIR)
  assert.equal(lookSwatch(suit, 'tie'), null)
  assert.equal(lookSwatch(suit, 'height'), null)
  assert.equal(lookSwatch(suit, 'mass'), null)
  assert.equal(lookSwatch(suit, 'brow'), null)
  assert.equal(lookSwatch(suit, 'undertone'), null)
})

// --- The packed words ------------------------------------------------------------------------------------------

test('LOOK_FIELD: sixteen words; the look word\'s bit 0 is the valid flag and bit 6 the long-hair bit, its fields tile the rest to bit 30; the figure word is full; the face word tiles bits 0 to 30; the wardrobe word its low byte; the skin word its low thirty bits; the cloth word (5) its low eighteen bits, the two weaves, the two cuts and the sleeves; the accessory word (6) its low fifteen bits, the shoe\'s style, the frames, the watch and the pin; the tattoo word (7) its low thirty-one bits, four zones and the ink, its bit 31 the street flag; the second tattoo word (8) its low fourteen bits, the two forearms; words 9 to 15 spare; each field wide enough for its slot', () => {
  assert.equal(LOOK_WORDS, 16)
  const used = Array.from({ length: LOOK_WORDS }, (_, w) => new Set<number>(w === 0 ? [0, LONG_HAIR_BIT] : []))
  const claim = (slot: string, word: number, shift: number, width: number) => {
    assert.ok(word >= 0 && word < LOOK_WORDS && shift + width <= 32, `${slot} inside the genome`)
    for (let b = shift; b < shift + width; b++) {
      assert.ok(!used[word].has(b), `${slot} overlaps bit ${b} of word ${word}`)
      used[word].add(b)
    }
  }
  for (const slot of LOOK_SLOTS) {
    const [word, shift, width] = LOOK_FIELD[slot]
    const high = LOOK_FIELD_HIGH[slot]
    const largest = Math.max(...BODIES.map((b) => lookSize(b, slot)))
    assert.ok(largest <= 1 << (width + (high ? high[2] : 0)), `${slot}: ${largest} options in ${width} bits${high ? ` and ${high[2]} high` : ''}`)
    claim(slot, word, shift, width)
    if (high) claim(`${slot} (high)`, ...high)
    const expected = (LOOK_BODY_SLIDERS as readonly string[]).includes(slot) ? 1 : (LOOK_FACE_SLIDERS as readonly string[]).includes(slot) || slot === 'hairStyle' ? 2 : slot === 'layer' || slot === 'trim' || slot === 'scarf' ? 3 : slot === 'topWeave' || slot === 'bottomWeave' || slot === 'cut' || slot === 'bottomCut' ? 5 : slot === 'footwear' || slot === 'frames' || slot === 'watch' || slot === 'lapelPin' ? 6 : slot === 'tattooHand' || slot === 'tattooHandR' || slot === 'tattooNeck' || slot === 'tattooNape' || slot === 'tattooInk' ? 7 : slot === 'tattooForearm' || slot === 'tattooForearmR' ? 8 : slot === 'sleeves' ? 5 : (LOOK_GENOME_SLOTS as readonly string[]).includes(slot) ? 4 : 0
    assert.equal(word, expected, `${slot} is in word ${expected}`)
    assert.equal(word >= 4, (LOOK_GENOME_SLOTS as readonly string[]).includes(slot), `${slot}: the genome's later words hold its later slots alone`)
  }
  assert.deepEqual(Object.keys(LOOK_FIELD_HIGH), ['skin', 'hairStyle'], 'the skin and the hair style outgrew their fields')
  assert.deepEqual([LOOK_FIELD_HIGH.skin, LOOK_FIELD_HIGH.hairStyle], [[4, 0, 2], [4, 7, 2]])
  assert.deepEqual([LOOK_FIELD.vitiligo, LOOK_FIELD.freckles, LOOK_FIELD.curl, LOOK_FIELD.headwear, LOOK_FIELD.headwearColour], [[4, 2, 3], [4, 5, 2], [4, 9, 4], [4, 13, 3], [4, 16, 3]])
  assert.deepEqual([LOOK_FIELD.facialHair, LOOK_FIELD.hearing, LOOK_FIELD.prosthetic, LOOK_FIELD.prostheticFinish], [[4, 19, 3], [4, 22, 3], [4, 25, 3], [4, 28, 2]])
  assert.deepEqual([...used[4]].sort((a, b) => a - b), Array.from({ length: 30 }, (_, i) => i), 'the skin word\'s low thirty bits; the top two spare')
  assert.deepEqual([LOOK_FIELD.topWeave, LOOK_FIELD.bottomWeave, LOOK_FIELD.cut, LOOK_FIELD.bottomCut], [[5, 0, 4], [5, 4, 4], [5, 8, 4], [5, 12, 4]], 'the cloth word: the top\'s weave, the bottom\'s, the cut, the lower cut')
  assert.deepEqual(LOOK_FIELD.sleeves, [5, 16, 2], 'the cloth word\'s sleeves, after the lower cut')
  assert.deepEqual([...used[5]].sort((a, b) => a - b), Array.from({ length: 18 }, (_, i) => i), 'the cloth word\'s low eighteen bits; the rest spare (the legs\' [5, 18, 2] next)')
  assert.deepEqual([LOOK_FIELD.footwear, LOOK_FIELD.frames, LOOK_FIELD.watch, LOOK_FIELD.lapelPin], [[6, 0, 5], [6, 5, 4], [6, 9, 3], [6, 12, 3]], 'the accessory word: the shoe\'s style, the frames, the watch, the pin')
  assert.deepEqual([...used[6]].sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i), 'the accessory word\'s low fifteen bits; bits 15 to 31 are the next slice\'s')
  assert.deepEqual([LOOK_FIELD.tattooHand, LOOK_FIELD.tattooHandR, LOOK_FIELD.tattooNeck, LOOK_FIELD.tattooNape, LOOK_FIELD.tattooInk], [[7, 0, 7], [7, 7, 7], [7, 14, 7], [7, 21, 7], [7, 28, 3]], 'the tattoo word: the left hand, the right hand, the neck, the nape, the ink')
  assert.deepEqual([...used[7]].sort((a, b) => a - b), Array.from({ length: 31 }, (_, i) => i), 'the tattoo word\'s low thirty-one bits')
  assert.ok(!used[7].has(31), 'bit 31: the street flag, the shader\'s and never a field\'s')
  assert.deepEqual({ ...LOOK_STREET_FLAG }, { word: 7, bit: 31 })
  assert.deepEqual([LOOK_FIELD.tattooForearm, LOOK_FIELD.tattooForearmR], [[8, 0, 7], [8, 7, 7]], 'the second tattoo word: the left forearm, the right')
  assert.deepEqual([...used[8]].sort((a, b) => a - b), Array.from({ length: 14 }, (_, i) => i), 'the second tattoo word\'s low fourteen bits; the calf\'s and the ankle\'s next')
  for (let w = 9; w < LOOK_WORDS; w++) assert.equal(used[w].size, 0, `word ${w} is spare`)
  assert.ok(Object.isFrozen(LOOK_FIELD_HIGH))
  assert.equal(used[0].size, 31)
  assert.ok(!used[0].has(31), 'the look word\'s top bit is spare')
  assert.equal(used[1].size, 32)
  assert.equal(used[2].size, 31)
  assert.ok(!used[2].has(31), 'the face word\'s top bit is spare')
  assert.deepEqual([...used[3]].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7], 'the wardrobe word\'s low byte; the rest spare')
  for (const piece of ['tie', 'bag', 'cup', 'glasses'] as const) {
    const slot = piece === 'glasses' ? 'eyewear' : piece
    assert.deepEqual(LOOK_FIELD[slot], [0, 2 + LOOK_PIECE_BIT[piece], 1])
  }
  assert.equal(LONG_HAIR_BIT, 2 + LOOK_PIECE_BIT.longHair)
  assert.equal(LONG_HAIR_BIT, 6)
  assert.deepEqual(LOOK_FIELD.hairStyle, [2, 28, 3])
  assert.deepEqual(LOOK_FIELD.body, [0, 1, 2])
  assert.deepEqual([LOOK_FIELD.age, LOOK_FIELD.undertone], [[0, 26, 3], [0, 29, 2]], 'where the legacy height and build sat')
  assert.deepEqual([LOOK_FIELD.height, LOOK_FIELD.mass, LOOK_FIELD.head], [[1, 0, 5], [1, 5, 4], [1, 29, 3]])
  assert.deepEqual([LOOK_FIELD.brow, LOOK_FIELD.jaw, LOOK_FIELD.lips], [[2, 0, 4], [2, 4, 4], [2, 24, 4]])
  assert.deepEqual([LOOK_FIELD.layer, LOOK_FIELD.trim, LOOK_FIELD.scarf], [[3, 0, 2], [3, 2, 3], [3, 5, 3]])
  assert.deepEqual([LEGACY_LOOK_FIELD.height, LEGACY_LOOK_FIELD.build, LEGACY_LOOK_FIELD.steps], [[26, 3], [29, 3], 8])
})

test('packGenome/unpackGenome round-trip every slot value of every body; the genome\'s first four words are packLook/packFigure/packFace/packWardrobe; a packed look word always has bit 0 set; a look of the four words alone has its later words zero and round-trips through unpackLook', () => {
  let count = 0
  for (const b of BODIES) {
    for (const slot of LOOK_SLOTS) {
      if (slot === 'body') continue
      for (let v = 0; v < lookSize(b, slot); v++) {
        const look = withSlot(zero(b), slot, v)
        const genome = packGenome(look)
        assert.equal(genome.length, LOOK_WORDS)
        const [word, figure, face, wardrobe] = words(look)
        assert.deepEqual(genome.slice(0, 4), [word, figure, face, wardrobe])
        assert.equal(word & 1, 1)
        for (const w of genome) assert.ok(w >= 0 && w <= 0xffffffff && Number.isInteger(w))
        assert.deepEqual(unpackGenome(genome), look, `${LOOK_BODIES[b]} ${slot}=${v}`)
        // Every value an older look could hold leaves the later words zero, so its four words carry it alone.
        const older: boolean = !((LOOK_GENOME_SLOTS as readonly string[]).includes(slot) && v > 0) && !(slot === 'skin' && v >= 8) && !(slot === 'hairStyle' && v >= 8)
        assert.equal(genome.slice(4).every((w) => w === 0), older, `${slot}=${v}: later words ${older ? 'zero' : 'used'}`)
        if (older) assert.deepEqual(unpackLook(word, figure, face, wardrobe), look)
        count++
      }
    }
    // Every slot at its last option at once.
    const full: Record<string, number> = {}
    for (const s of LOOK_SLOTS) full[s] = s === 'body' ? b : lookSize(b, s) - 1
    assert.deepEqual(unpackGenome(packGenome(full as Look)), full)
  }
  assert.ok(count > 800)
  // A Monk tone: its low three bits in the look word, its high bits in the skin word.
  const deepest = withSlot(zero(1), 'skin', monkSkin(9))
  assert.equal(deepest.skin, 17)
  assert.equal((packLook(deepest) >>> LOOK_FIELD.skin[1]) & 7, 17 & 7)
  assert.equal(packGenome(deepest)[4], 17 >>> 3)
  assert.equal(unpackLook(...words(deepest))!.skin, 17 & 7, 'the four words alone name an older tone: a Monk tone needs the genome (a code carries it in its tail, which an older reader refuses whole)')
  assert.deepEqual(unpackGenome(packGenome(deepest).slice(0, 5)), deepest, 'words not given are zero')
  const marked = withSlot(withSlot(withSlot(zero(3), 'skin', monkSkin(6)), 'vitiligo', VITILIGO.oneSide), 'freckles', 3)
  assert.equal(packGenome(marked)[4], (14 >>> 3) | (VITILIGO.oneSide << 2) | (3 << 5))
  assert.deepEqual(packGenome(marked).slice(5), new Array(11).fill(0), 'words 5 to 15 spare')
  assert.deepEqual(unpackGenome(packGenome(marked)), marked)
  // The head's last step uses the figure word's top bits: the words are unsigned.
  const tall = withSlot(withSlot(zero(0), 'head', 7), 'height', 31)
  assert.ok(packFigure(tall) > 0x7fffffff)
  assert.deepEqual(unpackLook(...words(tall)), tall)
  // The spare top bits are zero; the body sliders live in the figure word alone, the face sliders in the face word alone.
  assert.equal(packLook(tall) >>> 31, 0)
  assert.equal(packFace(withSlot(zero(0), 'lips', 15)) >>> 31, 0)
  assert.equal(packLook(tall), packLook(zero(0)))
  assert.equal(packFace(tall), packFace(zero(0)))
  assert.equal(packWardrobe(tall), packWardrobe(zero(0)))
  assert.equal(packFigure(withSlot(zero(0), 'shoes', 2)), packFigure(zero(0)))
  const nosed = withSlot(zero(0), 'nose', 3)
  assert.equal(packLook(nosed), packLook(zero(0)))
  assert.equal(packFigure(nosed), packFigure(zero(0)))
  assert.notEqual(packFace(nosed), packFace(zero(0)))
  const scarfed = withSlot(withSlot(withSlot(zero(0), 'layer', LAYER.coat), 'trim', 5), 'scarf', 7)
  assert.equal(packLook(scarfed), packLook(zero(0)), 'the wardrobe lives in its own word')
  assert.equal(packFigure(scarfed), packFigure(zero(0)))
  assert.equal(packFace(scarfed), packFace(zero(0)))
  assert.equal(packWardrobe(scarfed), LAYER.coat | (5 << 2) | (7 << 5))
  assert.equal(packWardrobe(scarfed) >>> 8, 0, 'its top three bytes are spare')
  assert.equal(packWardrobe(zero(0)), 0, 'the jacket, a matching trim and no scarf pack to zero: an old record\'s word')
  // The long-hair bit of the look word follows the style: set for long hair alone.
  for (const style of [0, 1, 2, 3, 4]) assert.equal((packLook(withSlot(zero(2), 'hairStyle', style)) >>> LONG_HAIR_BIT) & 1, style === HAIR.long ? 1 : 0, `style ${style}`)
  assert.equal(packLook(withSlot(zero(2), 'hairStyle', 2)), packLook(zero(2)), 'a bob changes the face word alone')
})

test('unpackLook refuses LOOK_NONE, words outside u32, fields outside the body\'s options, a long-hair bit that disagrees with the style, and a fourth layer', () => {
  assert.equal(unpackLook(LOOK_NONE, 0, 0, 0), null)
  assert.equal(unpackLook(LOOK_NONE, packFigure(zero(0)), packFace(zero(0)), 0), null)
  for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 32 + 1, 2]) assert.equal(unpackLook(bad, 0, 0, 0), null)
  for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 32 + 1]) {
    assert.equal(unpackLook(packLook(zero(0)), bad, 0, 0), null)
    assert.equal(unpackLook(packLook(zero(0)), 0, bad, 0), null)
    assert.equal(unpackLook(packLook(zero(0)), 0, 0, bad), null)
  }
  const [suit, figure, face, wardrobe] = words(zero(0))
  assert.equal(unpackLook(suit | (3 << LOOK_FIELD.shoes[1]), figure, face, wardrobe), null, 'the suit has three shoes')
  assert.equal(unpackLook(suit | (9 << LOOK_FIELD.hairColour[1]), figure, face, wardrobe), null, 'nine hair colours')
  assert.equal(unpackLook(suit | (7 << LOOK_FIELD.top[1]), figure, face, wardrobe), null, 'seven suit cloths')
  assert.equal(unpackLook(packLook(zero(2)) | (4 << LOOK_FIELD.bottom[1]), figure, face, wardrobe), null, 'matching plus three dark trousers')
  // The face word's three style bits are all styles now (HAIR_STYLES: thirty-two, the skin word's two bits above them).
  assert.equal(unpackLook(suit, figure, 5 << LOOK_FIELD.hairStyle[1], wardrobe)?.hairStyle, 5, 'the buzz cut')
  assert.equal(unpackGenome([suit, figure, 7 << LOOK_FIELD.hairStyle[1], wardrobe, 3 << LOOK_FIELD_HIGH.hairStyle![1]])?.hairStyle, 31, 'the last style')
  assert.equal(packLook(withSlot(zero(0), 'shoes', 3)), LOOK_NONE, 'nothing outside the wardrobe packs')
  assert.equal(packFigure(withSlot(zero(0), 'shoes', 3)), 0)
  assert.equal(packFace(withSlot(zero(0), 'shoes', 3)), 0)
  // Every value of the figure word is a figure: its fields are exactly as wide as their sliders. The face word's
  // sliders likewise; its style alone can overflow.
  for (const f of [0, 0xffffffff, 0x12345678, 0x80000001]) assert.notEqual(unpackLook(suit, f, face, wardrobe), null)
  assert.equal(unpackLook(suit, 0xffffffff, face, wardrobe)!.height, 31)
  assert.equal(unpackLook(suit, 0xffffffff, face, wardrobe)!.head, 7)
  assert.deepEqual(unpackLook(suit, figure, 0x0fffffff, wardrobe), { ...zero(0), brow: 15, jaw: 15, chin: 15, cheek: 15, nose: 15, eyes: 15, lips: 15 })
  // The look word's bit 6 must say what the face word's style says: a forged pair is no look.
  assert.equal(unpackLook(suit | (1 << LONG_HAIR_BIT), figure, face, wardrobe), null, 'long-hair bit, short style')
  assert.equal(unpackLook(suit, figure, face | (HAIR.long << LOOK_FIELD.hairStyle[1]), wardrobe), null, 'long style, no bit')
  assert.deepEqual(unpackLook(suit | (1 << LONG_HAIR_BIT), figure, face | (HAIR.long << LOOK_FIELD.hairStyle[1]), wardrobe), withSlot(zero(0), 'hairStyle', HAIR.long))
  assert.deepEqual(unpackLook(suit, figure, face | (HAIR.bun << LOOK_FIELD.hairStyle[1]), wardrobe), withSlot(zero(0), 'hairStyle', HAIR.bun))
  // The wardrobe word: a fourth layer is no layer; the trim and the scarf fill their three bits; the spare bits are ignored.
  assert.equal(unpackLook(suit, figure, face, 3), null, 'three layers')
  assert.deepEqual(unpackLook(suit, figure, face, 2), withSlot(zero(0), 'layer', LAYER.coat))
  assert.deepEqual(unpackLook(suit, figure, face, (7 << LOOK_FIELD.trim[1]) | (7 << LOOK_FIELD.scarf[1])), { ...zero(0), trim: 7, scarf: 7 })
  assert.deepEqual(unpackLook(suit, figure, face, 0xffffff00), zero(0), 'the spare bits')
  assert.equal(unpackLook(suit, figure, face, 0xffffffff), null, 'a full word: the layer 3')
})

test('lookMask: the pieces land where the crowd\'s vertex stage (crowdBody.ts) tests them (tie 2, bag 4, cup 8, long hair 16, glasses 32, the cap 64, a bob 128, a bun 256, the face 512, the coat 1024, the scarf 2048)', () => {
  assert.equal(lookMask(LOOK_NONE, 0, 0), 0)
  assert.equal(lookMask(LOOK_NONE, packFace(withSlot(zero(0), 'hairStyle', 1)), 0xff), 0)
  const cap = 1 << LOOK_PIECE_BIT.hairCap, face = 1 << LOOK_PIECE_BIT.face
  assert.equal(lookMask(...pair(zero(0))), cap | face, 'short hair: the cap and the features')
  const pieces: [LookSlot, number][] = [['tie', 2], ['bag', 4], ['cup', 8], ['eyewear', 32]]
  let all = zero(1)
  for (const [slot, bit] of pieces) {
    assert.equal(lookMask(...pair(withSlot(zero(1), slot, 1))), bit | cap | face)
    all = withSlot(all, slot, 1)
  }
  const [word, faceWord, wardrobeWord] = pair(all)
  assert.equal(lookMask(word, faceWord, wardrobeWord), 46 | cap | face)
  assert.equal((word >>> 2) & 46, 46, 'the wiring stage\'s expression')
  for (const [, bit] of pieces) assert.equal((lookMask(word, faceWord, wardrobeWord) >> Math.log2(bit)) & 1, 1)
  // The hair's pieces follow the style (hairBits): long hair with the cap, a bob with the cap, a bun with the cap, bald nothing.
  assert.deepEqual([0, 1, 2, 3, 4].map((s) => hairBits(s)), [cap, 16 | cap, 128 | cap, 256 | cap, 0])
  // The later styles' pieces, and the headwear: a hijab covers all the hair and adds the wrap; a beanie the crown (the
  // length below shows) and adds the hat; a flat cap the hat and the peak; a kippah is painted, no piece. The far body
  // has no headwear pieces: under a cover it keeps the cap (painted in the cloth).
  const bit = (p: keyof typeof LOOK_PIECE_BIT) => 1 << LOOK_PIECE_BIT[p]
  assert.equal(hairBits(HAIR.afro), cap | bit('volume'))
  assert.equal(hairBits(HAIR_STYLES.findIndex((h) => h.name === 'cornrow ponytail')), cap | bit('ponytail'))
  assert.equal(hairBits(HAIR.long, HEADWEAR.hijab), bit('wrap'))
  assert.equal(hairBits(HAIR.long, HEADWEAR.beanie), bit('longHair') | bit('hat'))
  assert.equal(hairBits(HAIR.afro, HEADWEAR.flatCap), bit('hat') | bit('brim'))
  assert.equal(hairBits(HAIR.afro, HEADWEAR.kippah), cap | bit('volume'))
  assert.equal(hairBits(HAIR.long, HEADWEAR.turban, false), cap)
  assert.equal(hairBits(HAIR.bald, HEADWEAR.beanie, false), cap)
  assert.equal(hairBits(HAIR.long, HEADWEAR.beanie, false), bit('longHair') | cap)
  // The style sets the shader tests agree with the table, piece by piece and paint bit by paint bit.
  for (const [i, style] of HAIR_STYLES.entries()) {
    for (const piece of HAIR_PIECES) assert.equal((HAIR_PIECE_STYLES[piece] >>> i) & 1, style.pieces.includes(piece) ? 1 : 0, `${style.name} ${piece}`)
    assert.equal(HAIR_TEXTURE_STYLES.reduce((t, set, b) => t | (((set >>> i) & 1) << b), 0), style.texture, style.name)
  }
  for (const style of [0, 1, 2, 3, 4]) assert.equal(lookMask(...pair(withSlot(zero(2), 'hairStyle', style))), hairBits(style) | face, `style ${style}`)
  assert.equal(lookMask(...pair(withSlot(all, 'hairStyle', HAIR.long))), 62 | cap | face)
  // The wardrobe's pieces: the coat with a coat layer, the scarf when one is worn (wardrobeBits, from the wardrobe word alone).
  const coat = 1 << LOOK_PIECE_BIT.coat, scarf = 1 << LOOK_PIECE_BIT.scarf
  assert.deepEqual([coat, scarf], [1024, 2048])
  assert.equal(lookMask(...pair(withSlot(zero(0), 'layer', LAYER.coat))), cap | face | coat)
  assert.equal(lookMask(...pair(withSlot(zero(0), 'layer', LAYER.shirt))), cap | face, 'shirt sleeves add no piece')
  for (const s of [1, 4, 7]) assert.equal(lookMask(...pair(withSlot(zero(0), 'scarf', s))), cap | face | scarf, `scarf ${s}`)
  assert.equal(lookMask(...pair(withSlot(zero(0), 'trim', 3))), cap | face, 'the trim is paint, not a piece')
  assert.equal(lookMask(...pair(withSlot(withSlot(all, 'layer', LAYER.coat), 'scarf', 2))), 46 | cap | face | coat | scarf)
  assert.deepEqual([0, 1, 2, 3].map((l) => wardrobeBits(l)), [0, 0, coat, 0])
  assert.equal(wardrobeBits(1 << LOOK_FIELD.scarf[1]), scarf)
  assert.equal(wardrobeBits((2 | (5 << LOOK_FIELD.trim[1]) | (7 << LOOK_FIELD.scarf[1])) >>> 0), coat | scarf)
  function pair(look: Look): [number, number, number] { return [packLook(look), packFace(look), packWardrobe(look)] }
})

// --- validateLook ----------------------------------------------------------------------------------------------

test('validateLook accepts exactly the catalogue and returns a frozen copy', () => {
  for (const b of BODIES) {
    const v = validateLook(zero(b))
    assert.deepEqual(v, zero(b))
    assert.ok(Object.isFrozen(v))
    assert.notEqual(v, zero(b))
  }
  assert.deepEqual(validateLook({ ...zero(0), skin: -0 }), zero(0))
  assert.equal(Object.is(validateLook({ ...zero(0), skin: -0 })!.skin, 0), true)
})

test('validateLook refuses NaN, negatives, non-integers, strings, out-of-range indices, unknown bodies, extra and missing keys', () => {
  for (const bad of [null, undefined, 1, 'suit', [], [0], () => 0, {}]) assert.equal(validateLook(bad), null)
  const suit = zero(0)
  for (const v of [NaN, -1, 0.5, Infinity, '0', true, null, undefined, 1e300]) assert.equal(validateLook({ ...suit, skin: v }), null, String(v))
  for (const b of BODIES) for (const slot of LOOK_SLOTS) {
    if (slot === 'body') continue
    assert.equal(validateLook(withSlot(zero(b), slot, lookSize(b, slot))), null, `${LOOK_BODIES[b]} ${slot}`)
    assert.notEqual(validateLook(withSlot(zero(b), slot, lookSize(b, slot) - 1)), null)
  }
  for (const body of [4, -1, 1.5, NaN, '0']) assert.equal(validateLook({ ...suit, body }), null)
  assert.equal(validateLook({ ...suit, extra: 0 }), null, 'extra key')
  const { cup: _cup, ...missing } = suit
  assert.equal(validateLook(missing), null, 'missing key')
  assert.equal(validateLook({ ...missing, extra: 0 }), null, 'same count, wrong key')
  // Range depends on the body: shoes 3 fits a blazer, not a suit.
  assert.notEqual(validateLook(withSlot(zero(1), 'shoes', 3)), null)
  assert.equal(validateLook(withSlot(zero(0), 'shoes', 3)), null)
})

test('a look kept before the figure (fourteen slots) is upgraded, not refused: its height to a stature, its build to a mass, the rest the middle step, the base face', () => {
  const navy = legacyOf(LOOK_PRESETS[0].look, 4, 3)
  const up = { ...LOOK_PRESETS[0].look, height: 16, mass: 6, muscle: 8, shoulders: 8, hips: 8, legs: 8, posture: 8, head: 4, ...BASE_FACE, ...BASE_WARDROBE }
  assert.deepEqual(upgradeLegacyLook(navy), up)
  assert.deepEqual(validateLook(navy), up, 'validateLook takes the legacy shape')
  assert.ok(Object.isFrozen(validateLook(navy)))
  // A man's height 4 of 0..7 drew 1.02 of the base height (1.785 m); a woman's height 3 drew 0.9629 (1.685 m).
  assert.equal(statureStep(1.02 * HEIGHT_BASE), 16)
  assert.equal(upgradeLegacyLook({ ...navy, body: 2, height: 3 })!.height, statureStep((0.92 + (3 / 7) * 0.1) * HEIGHT_BASE))
  assert.equal(upgradeLegacyLook({ ...navy, body: 2, height: 3 })!.height, 10)
  for (let h = 0; h < 8; h++) for (const body of BODIES) {
    const u = upgradeLegacyLook({ ...navy, body, height: h, bottom: 0, shoes: 0, top: 0 })!
    assert.notEqual(u, null)
    const scale = body >= 2 ? { base: 0.92, range: 0.1 } : { base: 0.94, range: 0.14 }
    assert.equal(u.height, statureStep((scale.base + (h / 7) * scale.range) * HEIGHT_BASE), `${LOOK_BODIES[body]} height ${h}`)
  }
  for (let b = 0; b < 8; b++) assert.equal(upgradeLegacyLook({ ...navy, build: b })!.mass, Math.round((b / 7) * 15))
  assert.equal(upgradeLegacyLook({ ...navy, build: 7 })!.mass, 15)
  assert.deepEqual(LOOK_SLIDER_MIDDLE, { slider: 8, head: 4, age: 3 })
  assert.equal(upgradeLegacyLook({ ...navy, hairStyle: 1 })!.hairStyle, 1, 'long hair carried')
  // Outside the legacy catalogue: refused, as before.
  assert.equal(upgradeLegacyLook({ ...navy, height: 8 }), null)
  assert.equal(upgradeLegacyLook({ ...navy, build: -1 }), null)
  assert.equal(upgradeLegacyLook({ ...navy, hairStyle: 2 }), null, 'two hair styles then')
  assert.equal(upgradeLegacyLook({ ...navy, shoes: 3 }), null, 'a suit has three shoes')
  assert.equal(upgradeLegacyLook({ ...navy, extra: 1 }), null)
  const { tie: _tie, ...fewer } = navy
  assert.equal(upgradeLegacyLook({ ...fewer, hat: 0 }), null, 'fourteen keys, the wrong ones')
  assert.equal(validateLook({ ...fewer, hat: 0 }), null)
  assert.equal(upgradeLegacyLook(LOOK_PRESETS[0].look), null, 'a new look is not a legacy one')
  // The legacy word (height and build in its top bits) upgrades the same way.
  const word = oldWordOf(navy, LEGACY_LOOK_SLOTS)
  assert.deepEqual(unpackLegacyLook(word), up)
  assert.equal(unpackLegacyLook(LOOK_NONE), null)
  assert.equal(unpackLegacyLook((word | (3 << LOOK_FIELD.shoes[1])) >>> 0), null)
})

test('a look kept before the face (twenty slots) is upgraded, not refused: the base face, the middle age, a neutral undertone, the hair style carried', () => {
  const navy = v2Of(LOOK_PRESETS[0].look)
  assert.equal(Object.keys(navy).length, 20)
  const up = { ...LOOK_PRESETS[0].look, ...BASE_FACE, ...BASE_WARDROBE }
  assert.deepEqual(upgradeFigureLook(navy), up)
  assert.deepEqual(validateLook(navy), up, 'validateLook takes the v2 shape')
  assert.ok(Object.isFrozen(validateLook(navy)))
  for (const style of [0, 1]) assert.equal(upgradeFigureLook({ ...navy, hairStyle: style })!.hairStyle, style)
  for (const b of BODIES) assert.deepEqual(upgradeFigureLook(v2Of(zero(b))), { ...zero(b), ...BASE_FACE }, LOOK_BODIES[b])
  for (let s = 0; s < 200; s++) {
    const look = lookFromSeed(s)
    const old = v2Of(look)
    assert.deepEqual(upgradeFigureLook(old), { ...look, ...BASE_FACE, ...BASE_WARDROBE, ...BASE_GENOME, hairStyle: old.hairStyle })
  }
  // Outside the v2 catalogue: refused.
  assert.equal(upgradeFigureLook({ ...navy, hairStyle: 2 }), null, 'two hair styles then')
  assert.equal(upgradeFigureLook({ ...navy, height: 32 }), null)
  assert.equal(upgradeFigureLook({ ...navy, shoes: 3 }), null)
  assert.equal(upgradeFigureLook({ ...navy, extra: 1 }), null)
  const { tie: _tie, ...fewer } = navy
  assert.equal(upgradeFigureLook({ ...fewer, hat: 0 }), null, 'twenty keys, the wrong ones')
  assert.equal(validateLook({ ...fewer, hat: 0 }), null)
  assert.equal(upgradeFigureLook(LOOK_PRESETS[0].look), null, 'a new look is not a v2 one')
  assert.equal(upgradeFigureLook(legacyOf(LOOK_PRESETS[0].look, 4, 3)), null, 'nor a legacy one')
  // The two-word record (the hair style at bit 6 of the look word) upgrades the same way.
  const word = oldWordOf(navy, LOOK_V2_SLOTS)
  const figure = packFigure(up)
  assert.deepEqual(unpackFigureLook(word, figure), up)
  assert.deepEqual(unpackFigureLook((word | (1 << LONG_HAIR_BIT)) >>> 0, figure), { ...up, hairStyle: 1 })
  assert.equal(unpackFigureLook(LOOK_NONE, figure), null)
  assert.equal(unpackFigureLook((word | (3 << LOOK_FIELD.shoes[1])) >>> 0, figure), null)
  assert.equal(unpackFigureLook(word, -1), null)
})

test('a look kept before the layers (twenty-nine slots) is upgraded, not refused: the jacket, a matching trim, no scarf, everything else carried', () => {
  const camel = v3Of(LOOK_PRESETS[2].look)
  assert.equal(Object.keys(camel).length, 29)
  const up = { ...LOOK_PRESETS[2].look, ...BASE_WARDROBE }
  assert.notDeepEqual(up, LOOK_PRESETS[2].look, 'the preset wears a trim and a scarf the old record could not')
  assert.deepEqual(upgradeFaceLook(camel), up)
  assert.deepEqual(validateLook(camel), up, 'validateLook takes the v3 shape')
  assert.ok(Object.isFrozen(validateLook(camel)))
  for (const b of BODIES) assert.deepEqual(upgradeFaceLook(v3Of(zero(b))), zero(b), LOOK_BODIES[b])
  for (let s = 0; s < 200; s++) {
    const look = lookFromSeed(s)
    assert.deepEqual(upgradeFaceLook(v3Of(look)), { ...look, ...BASE_WARDROBE, ...BASE_GENOME })
  }
  // Outside the v3 catalogue: refused.
  assert.equal(upgradeFaceLook({ ...camel, hairStyle: 5 }), null)
  assert.equal(upgradeFaceLook({ ...camel, shoes: 4 }), null)
  assert.equal(upgradeFaceLook({ ...camel, extra: 1 }), null)
  const { tie: _tie, ...fewer } = camel
  assert.equal(upgradeFaceLook({ ...fewer, hat: 0 }), null, 'twenty-nine keys, the wrong ones')
  assert.equal(validateLook({ ...fewer, hat: 0 }), null)
  assert.equal(upgradeFaceLook({ ...fewer, layer: 0 }), null, 'a layer makes it no v3 look')
  assert.equal(validateLook({ ...fewer, layer: 0 }), null)
  assert.equal(upgradeFaceLook(LOOK_PRESETS[2].look), null, 'a new look is not a v3 one')
  assert.equal(upgradeFaceLook(v2Of(LOOK_PRESETS[2].look)), null, 'nor a v2 one')
  // The three-word record upgrades the same way: the wardrobe word it never had is zero.
  const [word, figure, face] = words(up)
  assert.deepEqual(unpackFaceLook(word, figure, face), up)
  assert.deepEqual(unpackFaceLook(word, figure, face), unpackLook(word, figure, face, 0))
  assert.equal(unpackFaceLook(LOOK_NONE, figure, face), null)
  assert.equal(unpackFaceLook(((word & ~(15 << LOOK_FIELD.hairColour[1])) | (9 << LOOK_FIELD.hairColour[1])) >>> 0, figure, face), null, 'nine hair colours')
  assert.equal(unpackFaceLook(word | (1 << LONG_HAIR_BIT), figure, face), null, 'a forged long-hair bit')
  assert.equal(unpackFaceLook(word, figure, -1), null)
})

test('withLookSlot changes one slot within the catalogue; a body change keeps what fits and clamps the rest', () => {
  const suit = withSlot(withSlot(zero(0), 'bottom', 7), 'shoes', 2)
  assert.deepEqual(withLookSlot(suit, 'tie', 1), { ...suit, tie: 1 })
  assert.equal(withLookSlot(suit, 'tie', 2), null)
  assert.equal(withLookSlot(suit, 'shoes', 3), null)
  assert.equal(withLookSlot(suit, 'shoes', -1), null)
  assert.equal(withLookSlot(suit, 'shoes', 1.5), null)
  assert.equal(withLookSlot(suit, 'body', 4), null)
  assert.equal(withLookSlot(suit, 'height', 32), null)
  assert.equal(withLookSlot(suit, 'height', 31)!.height, 31)
  assert.equal(withLookSlot(suit, 'hairStyle', 4)!.hairStyle, 4)
  assert.equal(withLookSlot(suit, 'hairStyle', 31)!.hairStyle, 31)
  assert.equal(withLookSlot(suit, 'hairStyle', 32), null)
  assert.equal(withLookSlot(suit, 'nose', 15)!.nose, 15)
  assert.equal(withLookSlot(suit, 'nose', 16), null)
  assert.equal(withLookSlot(suit, 'undertone', 4), null)
  assert.equal(withLookSlot(suit, 'layer', 2)!.layer, 2)
  assert.equal(withLookSlot(suit, 'layer', 3), null)
  assert.equal(withLookSlot(suit, 'trim', 7)!.trim, 7)
  assert.equal(withLookSlot(suit, 'trim', 8), null)
  assert.equal(withLookSlot(suit, 'scarf', 7)!.scarf, 7)
  assert.equal(withLookSlot(suit, 'scarf', 8), null)
  const pantsuit = withLookSlot(suit, 'body', 2)!
  assert.equal(pantsuit.body, 2)
  assert.equal(pantsuit.bottom, 3, 'clamped to the last dark trouser')
  assert.equal(pantsuit.shoes, 2, 'kept')
  assert.notEqual(validateLook(pantsuit), null)
})

// --- The figure and the face -----------------------------------------------------------------------------------

test('the height slider is 32 steps from 1.50 m to 2.05 m; the other sliders 0..1 over their steps; a look\'s shape is humanoid.ts\'s', () => {
  assert.equal(statureOf(0), 1.5)
  assert.equal(statureOf(31), 2.05)
  for (let i = 0; i < 32; i++) {
    assert.equal(statureStep(statureOf(i)), i)
    assert.ok(i === 0 || statureOf(i) > statureOf(i - 1))
  }
  assert.equal(statureStep(1.8), 17)
  assert.equal(statureStep(0), 0)
  assert.equal(statureStep(3), 31)
  assert.equal(statureStep(NaN), LOOK_SLIDER_MIDDLE.slider)
  assert.equal(heightScale(zero(0)), 1.5 / HEIGHT_BASE)
  assert.ok(Math.abs(heightScale(withSlot(zero(0), 'height', 31)) - 2.05 / HEIGHT_BASE) < 1e-12)
  assert.ok(heightScale(withSlot(zero(0), 'height', 3)) < heightScale(withSlot(zero(0), 'height', 4)))
  assert.equal(sliderValue('mass', 0), 0)
  assert.equal(sliderValue('mass', 15), 1)
  assert.equal(sliderValue('head', 7), 1)
  assert.equal(sliderValue('legs', 30), 1, 'clamped')
  assert.equal(sliderValue('height', 31), 2.05)
  assert.deepEqual(bodyShapeOf(zero(3)), { height: 1.5, mass: 0, muscle: 0, shoulders: 0, hips: 0, legs: 0, posture: 0, head: 0 })
  const middle = { ...zero(0), height: statureStep(HEIGHT_BASE), mass: 8, muscle: 8, shoulders: 8, hips: 8, legs: 8, posture: 8, head: 4 }
  const shape = bodyShapeOf(middle)
  assert.ok(Math.abs(shape.height - SHAPE_NEUTRAL.height) < 0.01)
  for (const k of LOOK_BODY_SLIDERS) if (k !== 'height') assert.ok(Math.abs(shape[k] - SHAPE_NEUTRAL[k]) < 0.08, k)
  assert.ok(Object.isFrozen(shape))
})

test('the face sliders are sixteen steps about the base face: step 8 is exactly 0, step 0 is -1, step 15 is 7/8; a look\'s face is humanoid.ts\'s', () => {
  assert.equal(faceValue(8), 0)
  assert.equal(faceValue(0), -1)
  assert.equal(faceValue(15), 0.875)
  assert.equal(faceValue(4), -0.5)
  assert.equal(faceValue(40), 0.875, 'clamped')
  assert.equal(faceValue(-3), -1)
  for (let i = 1; i < 16; i++) assert.ok(faceValue(i) > faceValue(i - 1))
  assert.deepEqual(faceShapeOf({ ...zero(0), brow: 8, jaw: 8, chin: 8, cheek: 8, nose: 8, eyes: 8, lips: 8 }), FACE_NEUTRAL)
  assert.deepEqual(faceShapeOf(zero(1)), { brow: -1, jaw: -1, chin: -1, cheek: -1, nose: -1, eyes: -1, lips: -1 })
  assert.deepEqual(faceShapeOf(withSlot(zero(1), 'nose', 12)).nose, 0.5)
  assert.ok(Object.isFrozen(faceShapeOf(zero(0))))
  assert.deepEqual(Object.keys(faceShapeOf(zero(0))), [...LOOK_FACE_SLIDERS])
})

// --- Seeds -----------------------------------------------------------------------------------------------------

/** three's TSL hash (pcg) on exact integers, independently of shaderHash's arithmetic. */
const referenceHash = (seed: number): number => {
  const M = (1n << 32n) - 1n
  const state = (BigInt(seed) * 747796405n + 2891336453n) & M
  const word = (((state >> ((state >> 28n) + 4n)) ^ state) * 277803737n) & M
  const result = (word >> 22n) ^ word
  return Math.fround(Math.fround(Number(result)) * Math.fround(2 ** -32))
}

test('shaderHash is three\'s pcg hash bit for bit, and truncates its seed as u32() does', () => {
  for (const s of [0, 1, 2, 3, 7, 40, 53, 1234, 65535, 123456, 2 ** 24 - 1]) {
    assert.equal(shaderHash(s), referenceHash(s), String(s))
    assert.ok(shaderHash(s) >= 0 && shaderHash(s) < 1)
  }
  assert.equal(shaderHash(40.11), referenceHash(40))
  assert.equal(shaderHash(0.999), referenceHash(0))
  assert.equal(shaderHash(-3), referenceHash(0), 'u32 saturates below zero')
  const seen = new Set<number>()
  for (let s = 0; s < 1000; s++) seen.add(shaderHash(s))
  assert.ok(seen.size > 990, 'spread')
})

test('lookFromSeed is deterministic, always wearable, body = seed mod 4, and the crowd\'s choices for an agent', () => {
  for (let s = 0; s < 3000; s++) {
    const look = lookFromSeed(s)
    assert.deepEqual(lookFromSeed(s), look)
    assert.deepEqual(validateLook(look), look)
    assert.ok(Object.isFrozen(look))
    assert.equal(look.body, s % 4)
    assert.deepEqual(unpackGenome(packGenome(look)), look)
    // Recomputed the way crowd.ts writes it, from the two chains.
    const hp = (k: number) => shaderHash(Math.fround(Math.fround(s) + Math.fround(k * 13.37)))
    const hc = (k: number) => shaderHash(Math.fround(Math.fround(s) + Math.fround(k * 7.919)))
    const idx = (h: number, n: number) => Math.trunc(Math.fround(h * Math.fround(n - 0.001)))
    const woman = look.body >= 2
    assert.equal(look.tie, hp(1) >= Math.fround(0.3) ? 1 : 0)
    assert.equal(look.bag, hp(2) >= Math.fround(woman ? 0.62 : 0.7) ? 1 : 0)
    assert.equal(look.cup, hp(3) >= Math.fround(0.82) ? 1 : 0)
    assert.equal(look.eyewear, hp(5) >= Math.fround(0.78) ? 1 : 0)
    const notShort = hp(4) >= Math.fround(0.35)
    const split = hp(22)
    if (woman) assert.equal(look.hairStyle, !notShort ? 0 : split < Math.fround(0.34) ? 1 : split < Math.fround(0.67) ? 2 : 3)
    else assert.equal(look.hairStyle, split >= Math.fround(0.96) ? 4 : notShort ? 1 : 0)
    const stature = woman ? LOOK_STATURE.woman : LOOK_STATURE.man
    assert.equal(look.height, stature.from + Math.round(hp(6) * stature.span))
    assert.equal(look.mass, Math.round(hp(7) * 15))
    assert.equal(look.muscle, Math.round(hp(9) * 15))
    assert.equal(look.shoulders, Math.round(hp(10) * 15))
    assert.equal(look.hips, Math.round(hp(11) * 15))
    assert.equal(look.legs, Math.round(hp(12) * 15))
    assert.equal(look.posture, Math.round(hp(13) * 15))
    assert.equal(look.head, Math.round(hp(14) * 7))
    assert.equal(look.brow, Math.round(hp(15) * 15))
    assert.equal(look.jaw, Math.round(hp(16) * 15))
    assert.equal(look.chin, Math.round(hp(17) * 15))
    assert.equal(look.cheek, Math.round(hp(18) * 15))
    assert.equal(look.nose, Math.round(hp(19) * 15))
    assert.equal(look.eyes, Math.round(hp(20) * 15))
    assert.equal(look.lips, Math.round(hp(21) * 15))
    assert.equal(look.skin, 8 + idx(hc(1), 10), 'a Monk tone')
    assert.equal(look.vitiligo, hc(17) >= Math.fround(0.98) ? 1 + idx(hc(18), 6) : 0)
    assert.equal(look.freckles, hc(19) >= Math.fround(0.84) ? 1 + idx(hc(20), 3) : 0)
    assert.equal(look.hairColour, hc(9) >= Math.fround(0.9) ? 8 : idx(hc(2), 8))
    assert.equal(look.age, Math.round(hc(7) * 7))
    assert.equal(look.undertone, idx(hc(8), 4))
    const o = WARDROBE.outfits[look.body]
    assert.equal(look.top, idx(hc(3), LOOK_PALETTE[o.top].length))
    assert.equal(look.shirt, idx(hc(5), LOOK_PALETTE[o.shirt].length))
    assert.equal(look.shoes, idx(hc(6), LOOK_PALETTE[o.shoes].length))
    if (look.body === 0) assert.equal(look.bottom, 0, 'the suit\'s trousers match')
    else if (look.body === 2) assert.equal(look.bottom, hc(10) >= Math.fround(0.6) ? 1 + idx(hc(4), 3) : 0)
    else assert.equal(look.bottom, idx(hc(4), LOOK_PALETTE[o.bottom].length))
    // The wardrobe: the layer on link 23 of the pieces' chain, the scarf on 24 with its cloth from the colours' 15, the trim's contrast on the colours' 14 with its cloth from 16.
    const layerLink = hp(LOOK_HASHED_LAYER)
    assert.equal(look.layer, layerLink < Math.fround(0.2) ? LAYER.shirt : layerLink >= Math.fround(0.85) ? LAYER.coat : LAYER.jacket)
    assert.equal(look.trim, hc(14) >= Math.fround(0.8) ? 1 + idx(hc(16), 7) : 0)
    assert.equal(look.scarf, hp(LOOK_HASHED_SCARF) >= Math.fround(0.88) ? 1 + idx(hc(15), 7) : 0)
    // The skin word's later fields: the curl on the colours' 25; a man's facial hair on 26 with its style on 31; the
    // hearing devices on the pieces' 26; a prosthetic on the colours' 28, its limb on 29 and its finish on 30.
    assert.equal(look.curl, 1 + idx(hc(25), 12))
    assert.equal(look.facialHair, !woman && hc(26) >= Math.fround(0.55) ? 1 + idx(hc(31), 5) : 0)
    assert.equal(look.hearing, hp(26) >= Math.fround(0.993) ? 2 : hp(26) >= Math.fround(0.975) ? 1 : 0)
    const limb = hc(28) >= Math.fround(0.99)
    assert.equal(look.prosthetic, limb ? 1 + idx(hc(29), 4) : 0)
    assert.equal(look.prostheticFinish, limb ? idx(hc(30), 4) : 0)
    // The cloth word: four tops in ten woven, on the colours' 32, one of the body's eight weaves on 33; the trousers
    // follow the top as `matching` (0), so the hash never sets the bottom's.
    assert.equal(look.topWeave, hc(32) >= Math.fround(0.6) ? WEAVE_STREET[look.body][idx(hc(33), 8)] : 0)
    assert.equal(look.bottomWeave, 0)
    // The cut: three outer layers in ten, on the colours' 34, one of the body's eight cuts on 35.
    assert.equal(look.cut, hc(34) >= Math.fround(0.7) ? CUT_STREET[look.body][idx(hc(35), 8)] : 0)
    // The accessory word: the shoe's style on the colours' 38, one of the body's eight entries on 39; a frame finish
    // for glasses on 40, which of the seven on 41; the watch on 42; the pin on 43, none in shirt sleeves.
    assert.equal(look.footwear, hc(38) >= Math.fround(0.45) ? FOOTWEAR_STREET[look.body][idx(hc(39), 8)] : 0)
    assert.equal(look.frames, look.eyewear === 1 && hc(40) >= Math.fround(0.5) ? 1 + idx(hc(41), 7) : 0)
    const wrist = hc(42)
    assert.equal(look.watch, wrist >= Math.fround(0.93) ? 4 : wrist >= Math.fround(0.84) ? 3 : wrist >= Math.fround(0.72) ? 1 : 0)
    const lapel = hc(43)
    assert.equal(look.lapelPin, look.layer === LAYER.shirt ? 0 : lapel >= Math.fround(0.98) ? 3 : lapel >= Math.fround(0.96) ? 2 : 0)
    // The tattoo word: a carrier on the colours' 44 (one in five), the zone set on 45, the set's first zone's design on
    // 46 and its second's on 47 (always a design after the studio's twelve), the ink on 48; the look holds the hands,
    // the neck, the nape and the forearms, and the ink only where one of them is inked; a forearm rolls the sleeves
    // unless a coat is worn.
    const sets = [1, 2, 4, 8, 16, 32, 48, 192]
    const set = hc(44) >= Math.fround(0.8) ? sets[idx(hc(45), 8)] : 0
    const zone = (z: number) => ((set >> z) & 1) === 0 ? 0 : 13 + idx(hc((set & ((1 << z) - 1)) === 0 ? 46 : 47), 52)
    assert.deepEqual([look.tattooHand, look.tattooHandR, look.tattooNeck, look.tattooNape, look.tattooForearm, look.tattooForearmR], [zone(0), zone(1), zone(2), zone(3), zone(4), zone(5)])
    assert.equal(look.sleeves, (set & 48) !== 0 && look.layer !== LAYER.coat ? 1 : 0)
    const ink = hc(48)
    assert.equal(look.tattooInk, (set & 63) === 0 ? 0 : ink >= Math.fround(0.98) ? 2 : ink >= Math.fround(0.95) ? 6 : ink >= Math.fround(0.91) ? 5 : ink >= Math.fround(0.84) ? 1 : ink >= Math.fround(0.7) ? 7 : 0)
  }
  // Odd seeds still give a look: the city must always dress someone.
  for (const s of [NaN, -5, Infinity, 1.7, 2 ** 40, 0xffffffff]) assert.deepEqual(validateLook(lookFromSeed(s)), lookFromSeed(s))
  assert.deepEqual(lookFromSeed(-5), lookFromSeed(5))
  assert.deepEqual(lookFromSeed(1.7), lookFromSeed(1))
})

test('the two hash chains never share a link: no colour link the fragment reads truncates to the integer a pieces link does', () => {
  // shaderHash takes u32(seed + k × step): two links whose offsets truncate alike give one number to both chains, and
  // a beard's style followed the jaw's slider when the colours' link 27 met the pieces' 16.
  const atColour = (k: number) => Math.trunc(Math.fround(k * LOOK_HASH.colours))
  const atPieces = (k: number) => Math.trunc(Math.fround(k * LOOK_HASH.pieces))
  const colourLinks = new Set([...Array.from({ length: 12 }, (_, i) => i + 1), ...Object.values(LOOK_HASHED_COLOUR), LOOK_HASHED_COLOUR.marks + 1, LOOK_HASHED_COLOUR.marks + 2])
  const piecesAt = new Map(Array.from({ length: 40 }, (_, i) => [atPieces(i + 1), i + 1]))
  for (const k of colourLinks) assert.equal(piecesAt.get(atColour(k)), undefined, `colours' link ${k} truncates to ${atColour(k)}, the pieces' link ${piecesAt.get(atColour(k))}'s`)
  assert.ok(Math.max(LOOK_HASHED_HEARING, LOOK_HASHED_HEADWEAR, LOOK_HASHED_SCARF, LOOK_HASHED_LAYER, LOOK_HASHED_HAIR_SPLIT) <= 40, 'every pieces link is checked')
})

test('lookFromSeed is pinned for the player\'s slot and the first agents, and its odds match the crowd\'s', () => {
  assert.deepEqual(lookFromSeed(0), { body: 0, height: 26, mass: 11, muscle: 4, shoulders: 0, hips: 8, legs: 8, posture: 8, head: 4, brow: 4, jaw: 4, chin: 5, cheek: 13, nose: 14, eyes: 14, lips: 2, skin: 12, age: 6, undertone: 2, vitiligo: 0, freckles: 0, hairStyle: 1, curl: 7, headwear: 0, headwearColour: 0, facialHair: 5, hearing: 0, prosthetic: 0, prostheticFinish: 0, hairColour: 1, layer: 0, cut: 0, top: 1, topWeave: 0, trim: 2, bottomCut: 0, bottom: 0, bottomWeave: 0, shirt: 2, shoes: 0, tie: 0, scarf: 0, eyewear: 0, bag: 1, cup: 0, footwear: 0, frames: 0, watch: 0, lapelPin: 0, tattooHand: 0, tattooHandR: 0, tattooNeck: 0, tattooNape: 0, tattooInk: 0, sleeves: 0, tattooForearm: 0, tattooForearmR: 0 })
  assert.deepEqual(lookFromSeed(1), { body: 1, height: 28, mass: 8, muscle: 14, shoulders: 4, hips: 15, legs: 12, posture: 5, head: 1, brow: 7, jaw: 11, chin: 15, cheek: 15, nose: 9, eyes: 4, lips: 4, skin: 9, age: 3, undertone: 2, vitiligo: 0, freckles: 0, hairStyle: 0, curl: 9, headwear: 0, headwearColour: 0, facialHair: 0, hearing: 0, prosthetic: 0, prostheticFinish: 0, hairColour: 1, layer: 0, cut: 0, top: 4, topWeave: 12, trim: 0, bottomCut: 0, bottom: 0, bottomWeave: 0, shirt: 3, shoes: 0, tie: 0, scarf: 2, eyewear: 0, bag: 1, cup: 0, footwear: 3, frames: 0, watch: 0, lapelPin: 0, tattooHand: 0, tattooHandR: 0, tattooNeck: 0, tattooNape: 0, tattooInk: 0, sleeves: 0, tattooForearm: 0, tattooForearmR: 0 })
  assert.deepEqual(lookFromSeed(2), { body: 2, height: 11, mass: 15, muscle: 12, shoulders: 4, hips: 4, legs: 3, posture: 2, head: 7, brow: 15, jaw: 2, chin: 2, cheek: 11, nose: 12, eyes: 1, lips: 6, skin: 11, age: 4, undertone: 2, vitiligo: 0, freckles: 0, hairStyle: 1, curl: 4, headwear: 0, headwearColour: 0, facialHair: 0, hearing: 0, prosthetic: 0, prostheticFinish: 0, hairColour: 6, layer: 0, cut: 0, top: 5, topWeave: 0, trim: 0, bottomCut: 5, bottom: 3, bottomWeave: 0, shirt: 4, shoes: 3, tie: 0, scarf: 0, eyewear: 0, bag: 0, cup: 0, footwear: 7, frames: 0, watch: 0, lapelPin: 0, tattooHand: 0, tattooHandR: 0, tattooNeck: 0, tattooNape: 0, tattooInk: 0, sleeves: 0, tattooForearm: 0, tattooForearmR: 0 })
  assert.deepEqual(lookFromSeed(3), { body: 3, height: 18, mass: 1, muscle: 4, shoulders: 10, hips: 2, legs: 1, posture: 10, head: 3, brow: 12, jaw: 9, chin: 8, cheek: 9, nose: 14, eyes: 7, lips: 6, skin: 12, age: 2, undertone: 0, vitiligo: 0, freckles: 0, hairStyle: 2, curl: 4, headwear: 0, headwearColour: 0, facialHair: 0, hearing: 0, prosthetic: 0, prostheticFinish: 0, hairColour: 6, layer: 0, cut: 10, top: 4, topWeave: 9, trim: 0, bottomCut: 1, bottom: 2, bottomWeave: 0, shirt: 1, shoes: 0, tie: 0, scarf: 7, eyewear: 1, bag: 0, cup: 0, footwear: 0, frames: 6, watch: 1, lapelPin: 0, tattooHand: 0, tattooHandR: 0, tattooNeck: 0, tattooNape: 0, tattooInk: 0, sleeves: 0, tattooForearm: 0, tattooForearmR: 0 })
  const n = 20000
  const rate = (pick: (l: Look) => number, from = 0, step = 1) => {
    let sum = 0, count = 0
    for (let s = from; s < n; s += step) { sum += pick(lookFromSeed(s)); count++ }
    return sum / count
  }
  const near = (got: number, want: number, name: string, tol = 0.03) => assert.ok(Math.abs(got - want) < tol, `${name}: ${got.toFixed(3)} vs ${want}`)
  near(rate((l) => l.tie), 1 - LOOK_ODDS.tie, 'tie')
  near(rate((l) => l.cup), 1 - LOOK_ODDS.cup, 'cup')
  near(rate((l) => l.eyewear), 1 - LOOK_ODDS.glasses, 'glasses')
  near(rate((l) => l.bag, 0, 4), 1 - LOOK_ODDS.bagMan, 'a man\'s bag')
  near(rate((l) => l.bag, 2, 4), 1 - LOOK_ODDS.bagWoman, 'a woman\'s bag')
  near(rate((l) => (l.hairColour === 8 ? 1 : 0)), 1 - LOOK_ODDS.grey, 'grey')
  near(rate((l) => (l.bottom > 0 ? 1 : 0), 2, 4), 1 - LOOK_ODDS.darkTrousers, 'dark trousers')
  // The wardrobe: shirt sleeves on one in five, a coat on three in twenty, a trim on one in five, a scarf on three in twenty-five; the cloths spread.
  near(rate((l) => (l.layer === LAYER.shirt ? 1 : 0)), LOOK_ODDS.shirtSleeves, 'shirt sleeves')
  near(rate((l) => (l.layer === LAYER.coat ? 1 : 0)), 1 - LOOK_ODDS.coat, 'a coat')
  near(rate((l) => (l.trim > 0 ? 1 : 0)), 1 - LOOK_ODDS.trim, 'a trim')
  near(rate((l) => (l.scarf > 0 ? 1 : 0)), 1 - LOOK_ODDS.scarf, 'a scarf')
  for (let c = 1; c <= 7; c++) {
    near(rate((l) => (l.trim === c ? 1 : 0)), (1 - LOOK_ODDS.trim) / 7, `trim cloth ${c}`, 0.01)
    near(rate((l) => (l.scarf === c ? 1 : 0)), (1 - LOOK_ODDS.scarf) / 7, `scarf cloth ${c}`, 0.01)
  }
  // The hair: a man is short, long or (one in twenty-five) bald; a woman short, or long, bob and bun in thirds of the rest.
  const style = (want: number, from: number) => rate((l) => (l.hairStyle === want ? 1 : 0), from, 4)
  near(style(HAIR.short, 0), LOOK_ODDS.longHair * LOOK_ODDS.bald, 'a man\'s short hair')
  near(style(HAIR.long, 0), (1 - LOOK_ODDS.longHair) * LOOK_ODDS.bald, 'a man\'s long hair')
  near(style(HAIR.bald, 0), 1 - LOOK_ODDS.bald, 'a bald man', 0.01)
  assert.equal(style(HAIR.bob, 0) + style(HAIR.bun, 0), 0, 'no man wears a bob or a bun')
  near(style(HAIR.short, 2), LOOK_ODDS.longHair, 'a woman\'s short hair')
  near(style(HAIR.long, 2), (1 - LOOK_ODDS.longHair) * LOOK_ODDS.bob, 'a woman\'s long hair')
  near(style(HAIR.bob, 2), (1 - LOOK_ODDS.longHair) * (LOOK_ODDS.bun - LOOK_ODDS.bob), 'a bob')
  near(style(HAIR.bun, 2), (1 - LOOK_ODDS.longHair) * (1 - LOOK_ODDS.bun), 'a bun')
  assert.equal(style(HAIR.bald, 2), 0, 'no woman is bald')
  // The hashed figure: men 1.64 m to 2.00 m, women 1.55 m to 1.87 m, the rest of the sliders over their whole range.
  near(rate((l) => statureOf(l.height), 0, 4), (statureOf(8) + statureOf(28)) / 2, 'a man\'s stature', 0.01)
  near(rate((l) => statureOf(l.height), 2, 4), (statureOf(3) + statureOf(21)) / 2, 'a woman\'s stature', 0.01)
  for (let s = 0; s < n; s++) {
    const l = lookFromSeed(s)
    const stature = l.body >= 2 ? LOOK_STATURE.woman : LOOK_STATURE.man
    assert.ok(l.height >= stature.from && l.height <= stature.from + stature.span)
  }
  near(rate((l) => l.mass / 15), 0.5, 'mass')
  near(rate((l) => l.head / 7), 0.5, 'head')
  // The face, the age and the undertone over their whole ranges.
  for (const f of LOOK_FACE_SLIDERS) near(rate((l) => l[f] / 15), 0.5, f)
  near(rate((l) => l.age / 7), 0.5, 'age')
  for (let u = 0; u < 4; u++) near(rate((l) => (l.undertone === u ? 1 : 0)), 0.25, `undertone ${u}`)
  // The skin word: the ten Monk tones evenly (never one of the eight older tones), vitiligo on two in a hundred, freckles on about one in six.
  for (let t = 0; t < 10; t++) near(rate((l) => (l.skin === monkSkin(t) ? 1 : 0)), 0.1, `mst-${t + 1}`, 0.01)
  assert.equal(rate((l) => (l.skin < 8 ? 1 : 0)), 0, 'the older tones are a chosen look\'s')
  near(rate((l) => (l.vitiligo > 0 ? 1 : 0)), 1 - LOOK_ODDS.vitiligo, 'vitiligo', 0.006)
  for (let v = 1; v < 7; v++) near(rate((l) => (l.vitiligo === v ? 1 : 0)), (1 - LOOK_ODDS.vitiligo) / 6, `vitiligo pattern ${v}`, 0.003)
  near(rate((l) => (l.freckles > 0 ? 1 : 0)), 1 - LOOK_ODDS.freckles, 'freckles', 0.01)
  for (let f = 1; f < 4; f++) near(rate((l) => (l.freckles === f ? 1 : 0)), (1 - LOOK_ODDS.freckles) / 3, `freckle density ${f}`, 0.01)
  // The cloth word: four tops in ten woven, each of the body's eight about as often; the bottom's left to follow.
  near(rate((l) => (l.topWeave > 0 ? 1 : 0)), 1 - LOOK_ODDS.weave, 'a woven top', 0.01)
  for (const b of BODIES) for (const w of WEAVE_STREET[b]) near(rate((l) => (l.topWeave === w ? 1 : 0), b, 4), (1 - LOOK_ODDS.weave) / 8, `${LOOK_BODIES[b]} in weave ${w}`, 0.012)
  assert.equal(rate((l) => l.bottomWeave), 0)
  // The lower cut: about one in three cut, each of the body's eight about as often.
  near(rate((l) => (l.bottomCut > 0 ? 1 : 0)), 1 - LOOK_ODDS.bottomCut, 'a lower cut', 0.01)
  for (const b of BODIES) for (const c of BOTTOM_CUT_STREET[b]) near(rate((l) => (l.bottomCut === c ? 1 : 0), b, 4), (1 - LOOK_ODDS.bottomCut) / 8, `${LOOK_BODIES[b]} in lower cut ${c}`, 0.012)
  // The accessory word, counted in one pass: a little over half the shoes styled on every body, each of the body's
  // entries as often as it is listed; a watch on about one wrist in four; half the glasses in a finish of their own; a
  // pin on a few jackets and coats; and never the tourbillon or the rank pin, which are the watch shop's.
  const shod = BODIES.map(() => new Map<number, number>())
  let watches = 0, glasses = 0, finished = 0, pins = 0
  for (let s = 0; s < n; s++) {
    const l = lookFromSeed(s)
    shod[l.body].set(l.footwear, (shod[l.body].get(l.footwear) ?? 0) + 1)
    if (l.watch > 0) watches++
    if (l.eyewear === 1) { glasses++; if (l.frames > 0) finished++ }
    if (l.lapelPin > 0) pins++
    assert.notEqual(l.watch, WATCH.tourbillon, `seed ${s}: the street wears no tourbillon`)
    assert.notEqual(l.lapelPin, LAPEL_PIN.rank, `seed ${s}: the street wears no rank pin`)
    if (l.eyewear === 0) assert.equal(l.frames, 0, 'no frame finish without glasses')
  }
  for (const b of BODIES) {
    const of = (f: number) => (shod[b].get(f) ?? 0) / (n / 4)
    near(1 - of(0), 1 - LOOK_ODDS.footwear, `${LOOK_BODIES[b]}'s styled shoes`, 0.02)
    for (const f of new Set(FOOTWEAR_STREET[b])) near(of(f), (FOOTWEAR_STREET[b].filter((x) => x === f).length / 8) * (1 - LOOK_ODDS.footwear), `${LOOK_BODIES[b]} in shoe style ${f}`, 0.015)
  }
  near(watches / n, 1 - LOOK_ODDS.watchSteel, 'a watch', 0.01)
  near(finished / glasses, 1 - LOOK_ODDS.frames, 'a frame finish, of those with glasses')
  near(pins / n, (1 - LOOK_ODDS.pinBar) * (1 - LOOK_ODDS.shirtSleeves), 'a lapel pin', 0.01)
})

/** Words that would name a people or their dress: no cloth, cut or garment carries one. */
const PEOPLE = /kente|adinkra|asante|ewe|maasai|navajo|aztec|tribal|ethnic|native|agbada|senator|tang|bandhgala|jodhpuri|sherwani|kebaya|haori|kimono|kilt|argyll|nehru|mandarin|dashiki|kurta|hanbok|qipao|cheongsam|sari|thobe/i

test('the weaves: sixteen cloths, plain first, none named for a people; the bottom\'s 0 follows a matching top; the street\'s eight per body, packed for the shader as crowd.ts reads them', () => {
  assert.deepEqual([...WARDROBE.weave], [
    'plain', 'twill', 'herringbone', 'pinstripe', 'chalk stripe', 'houndstooth', 'glen check', 'windowpane',
    'tartan', 'tweed', 'linen', 'silk', 'cashmere', 'merino', 'batik', 'strip weave',
  ])
  assert.deepEqual(Object.values(WEAVE), WARDROBE.weave.map((_, i) => i), 'WEAVE names the list in order')
  assert.equal(WEAVE.plain, 0, 'plain is 0: a look kept before the weaves is plain')
  for (const name of WARDROBE.weave) assert.doesNotMatch(name, PEOPLE, `${name}: a weave is named for its cloth, never a people`)
  for (const b of BODIES) {
    assert.deepEqual(lookOptions(b, 'topWeave').map((o) => o.name), [...WARDROBE.weave])
    const bottom = lookOptions(b, 'bottomWeave').map((o) => o.name)
    assert.deepEqual(bottom, [WARDROBE.outfits[b].matching ? 'matching' : 'plain', ...WARDROBE.weave.slice(1)], 'the bottom\'s 0 is matching where the trousers may be the jacket\'s cloth')
    // The street: eight distinct weaves, none plain, packed four bits each in list order.
    assert.equal(WEAVE_STREET[b].length, 8)
    assert.equal(new Set(WEAVE_STREET[b]).size, 8)
    assert.ok(!WEAVE_STREET[b].includes(WEAVE.plain))
    for (const [i, w] of WEAVE_STREET[b].entries()) assert.equal((WEAVE_STREET_PACKED[b] >>> (4 * i)) & 15, w)
  }
  assert.ok(WEAVE_STREET[0].includes(WEAVE.pinstripe) && WEAVE_STREET[1].includes(WEAVE.tweed) && WEAVE_STREET[3].includes(WEAVE.silk), 'the suit\'s suitings, the blazer\'s tweeds, the skirt suit\'s soft cloths')
  assert.equal(LOOK_ODDS.weave, 0.6)
  // crowd.ts reads the same words, links and lists: the look's weave or the street's, the bottom's 0 the top's where the
  // trousers match it (the suit's always for the hash, the pantsuit's under the dark-trousers odds), one paint per slot.
  assert.ok(CROWD.includes('const street = uint(WEAVE_STREET_PACKED[variant]).shiftRight(uint(h(LOOK_HASHED_COLOUR.weavePick).mul(8 - 0.001)).mul(uint(4))).bitAnd(uint(15))'))
  assert.ok(CROWD.includes('const topWeave = select(custom, gene(LOOK_FIELD.topWeave), select(h(LOOK_HASHED_COLOUR.weave).greaterThanEqual(LOOK_ODDS.weave), street, uint(0)))'))
  assert.ok(CROWD.includes('const matches = variant === 0 ? select(custom, bottomAt.equal(uint(0)), uint(1).equal(uint(1)))'))
  assert.ok(CROWD.includes(': variant === 2 ? select(custom, bottomAt.equal(uint(0)), h(10).lessThan(0.6)) : uint(0).equal(uint(1))'), 'the pantsuit\'s trousers match under the dark-trousers odds')
  assert.ok(CROWD.includes('const bottomWeave = select(custom.and(ownBottomWeave.notEqual(uint(0))), ownBottomWeave, select(matches, topWeave, uint(0)))'))
  assert.ok(CROWD.includes('const woven = weavePaint(select(onBottom, bottom, topCloth), select(onBottom, bottomWeave, select(slotIs(SLOT.TOP), topWeave, uint(0))), rig, select(raisedWaist, float(SLOT.BOTTOM), slot), footprint, near, variant === 3).toVar()'))
  assert.equal(LOOK_ODDS.darkTrousers, 0.6, 'the pantsuit\'s match is the dark-trousers odds')
  // The pixel's footprint is a derivative: read at the top of the stage, first of the shared values, before any branch.
  assert.ok(CROWD.includes('const footprint = fwidth(positionGeometry).length().max(0.00001).toVar()'))
  assert.ok(CROWD.includes('const shared = [footprint, ...links.values(),'))
})

test('the cuts: sixteen, the notch lapel first, none named for a people; the street\'s eight per body, packed for the shader; the notch lapel moves no line', () => {
  assert.deepEqual([...WARDROBE.cut], [
    'notch lapel', 'peak lapel', 'shawl collar', 'double-breasted', 'band collar', 'turtleneck', 'waistcoat', 'cardigan',
    'open front', 'belted', 'cropped', 'wrap front', 'zip front', 'side closure', 'quilted', 'patch pockets',
  ])
  assert.deepEqual(Object.values(CUT), WARDROBE.cut.map((_, i) => i), 'CUT names the list in order')
  assert.equal(CUT.notch, 0, 'the notch lapel is 0: a look kept before the cuts is cut as it was')
  for (const name of WARDROBE.cut) assert.doesNotMatch(name, PEOPLE, `${name}: a cut is named for itself, never a people's dress`)
  for (const b of BODIES) {
    assert.deepEqual(lookOptions(b, 'cut').map((o) => o.name), [...WARDROBE.cut])
    assert.equal(CUT_STREET[b].length, 8)
    assert.equal(new Set(CUT_STREET[b]).size, 8)
    assert.ok(!CUT_STREET[b].includes(CUT.notch))
    for (const [i, c] of CUT_STREET[b].entries()) assert.equal((CUT_STREET_PACKED[b] >>> (4 * i)) & 15, c)
  }
  assert.equal(LOOK_ODDS.cut, 0.7)
  // crowd.ts reads the same word, links and lists, and declares the cut with the shared values (three slots read it).
  assert.ok(CROWD.includes('const streetCut = uint(CUT_STREET_PACKED[variant]).shiftRight(uint(h(LOOK_HASHED_COLOUR.cutPick).mul(8 - 0.001)).mul(uint(4))).bitAnd(uint(15))'))
  assert.ok(CROWD.includes('const cut = select(custom, gene(LOOK_FIELD.cut), select(h(LOOK_HASHED_COLOUR.cut).greaterThanEqual(LOOK_ODDS.cut), streetCut, uint(0))).toVar()'))
  assert.ok(CROWD.includes('const shared = [footprint, ...links.values(), cut,'))
  // Under the notch lapel every line is where it was: each moved value falls through to the tailored one.
  assert.ok(CROWD.includes('select(vest, float(1.1), select(knit, float(1.14), tailored))))'), 'where the V closes')
  assert.ok(CROWD.includes("select(cutIs(CUT.wrap), float(1).sub(upV).mul(-0.06), float(0)))"), 'the V\'s centre')
  assert.ok(CROWD.includes('select(closed, float(0), float(GARMENT.lapel))))))'), 'the lapel\'s width')
  // The garment's marks: a column of buttons and the stitched lines, a turtleneck's knit up the neck.
  assert.ok(CROWD.includes('const turtleNeck = cutIs(CUT.turtleneck).and(layer.notEqual(uint(LAYER.shirt))).and(onTrunk.or(boneIs(BONE.HEAD).and(rest.y.lessThan(1.578))))'), 'the knit on the trunk\'s skin and up the neck below the chin ring')
  assert.ok(CROWD.includes('select(turtleNeck, knitShirt, select(watchHere, watchColour, select(armHere, limbColour, skinShown)))'))
  // The hashed crowd's cut is the colours' 34 and 35, the same links lookFromSeed draws it from.
  assert.deepEqual([LOOK_HASHED_COLOUR.cut, LOOK_HASHED_COLOUR.cutPick], [34, 35])
  // No tie under a turtleneck or a jacket closed to the neck: the mask drops it, on a jacket or a coat; the look keeps it.
  assert.deepEqual([...TIELESS_CUTS], [CUT.band, CUT.turtleneck, CUT.zip, CUT.side, CUT.quilted])
  const tied = validateLook({ ...lookFromSeed(0), tie: 1, layer: LAYER.jacket })!
  for (let c = 0; c < WARDROBE.cut.length; c++) {
    const cutLook = validateLook({ ...tied, cut: c })!
    assert.equal(lookWears(cutLook, PIECE.TIE), !TIELESS_CUTS.includes(c), `${WARDROBE.cut[c]}: the tie`)
    assert.equal(lookWears(validateLook({ ...cutLook, layer: LAYER.coat })!, PIECE.TIE), !TIELESS_CUTS.includes(c), `${WARDROBE.cut[c]} on a coat: the tie`)
    assert.equal(lookWears(validateLook({ ...cutLook, layer: LAYER.shirt })!, PIECE.TIE), true, `${WARDROBE.cut[c]} under shirt sleeves: the jacket is off, the tie is worn`)
    assert.equal(cutLook.tie, 1, 'the look keeps its tie')
  }
  assert.ok(CROWD.includes('const cutNow = select(custom, genomeQuad.y.shiftRight(uint(LOOK_FIELD.cut[1])).bitAnd(uint(15)), hashedCut)'))
  assert.ok(CROWD.includes('uint(CUT_STREET_PACKED[variant]).shiftRight(uint(hc(LOOK_HASHED_COLOUR.cutPick).mul(8 - 0.001)).mul(uint(4))).bitAnd(uint(15)), uint(0))'), 'the vertex stage draws the hashed cut as the fragment does')
  assert.ok(CROWD.includes('.sub(select(tieless, tieWorn, float(0)))'))
})

test('the garments: forty-four tops, named by what they are; each sets its layer, cut, weave (and a trim) and keeps the colours; garmentOf finds it back', () => {
  assert.equal(LOOK_GARMENTS.length, 44)
  assert.ok(Object.isFrozen(LOOK_GARMENTS))
  const names = new Set<string>()
  for (const g of LOOK_GARMENTS) {
    assert.match(g.name, /^[a-z][a-z -]*[a-z]$/, `${g.name}: lower-case ASCII words`)
    assert.ok(!names.has(g.name), `${g.name} is unique`)
    names.add(g.name)
    assert.doesNotMatch(g.name, PEOPLE, `${g.name}: a garment is named for itself, never a people's dress`)
    assert.ok(g.layer === LAYER.jacket || g.layer === LAYER.coat, `${g.name}: a jacket or a coat`)
    assert.ok(g.cut >= 0 && g.cut < WARDROBE.cut.length && g.topWeave >= 0 && g.topWeave < WARDROBE.weave.length)
    assert.equal(lookGarment(` ${g.name.toUpperCase()} `), g, 'case and space ignored')
    for (const b of BODIES) {
      const base = lookFromSeed(b)
      const worn = withGarment(base, g.name)
      assert.ok(worn, `${g.name} on body ${b}`)
      assert.deepEqual(validateLook(worn), worn)
      assert.deepEqual([worn.layer, worn.cut, worn.topWeave], [g.layer, g.cut, g.topWeave])
      assert.equal(worn.trim, g.trim ?? base.trim)
      for (const slot of LOOK_SLOTS) if (!['layer', 'cut', 'topWeave', 'trim'].includes(slot)) assert.equal(worn[slot], base[slot], `${g.name} keeps ${slot}`)
      assert.equal(garmentOf(worn)?.name, g.name, 'garmentOf finds the garment worn')
      assert.equal(parseLookCode(formatLookCode(worn))?.cut, g.cut, 'the code carries the cut')
    }
  }
  // Every cut is some garment's, so the catalogue shows each one.
  for (let c = 0; c < WARDROBE.cut.length; c++) assert.ok(LOOK_GARMENTS.some((g) => g.cut === c), `${WARDROBE.cut[c]} is worn by a garment`)
  assert.equal(lookGarment('cape'), null)
  assert.equal(withGarment(lookFromSeed(0), 'cape'), null)
  assert.deepEqual(changeLook(lookFromSeed(0), { kind: 'garment', name: 'Tweed Blazer' }, 0).look, withGarment(lookFromSeed(0), 'tweed blazer'))
  assert.match(changeLook(lookFromSeed(0), { kind: 'garment', name: 'cape' }, 0).error ?? '', /no garment named 'cape': pinstripe suit jacket, chalk stripe suit jacket/)
  assert.equal(garmentOf({ ...lookFromSeed(0), layer: LAYER.shirt }), null, 'shirt sleeves are no garment')
})

test('the lower cuts: sixteen for trousers and sixteen for the skirt, straight first, none named for a people; the body picks the list, and a crossing between skirt and trousers starts it again; the street\'s eight per body, packed for the shader as crowd.ts reads them', () => {
  assert.deepEqual([...WARDROBE.trouserCut], [
    'straight', 'pressed crease', 'pleated', 'turn-ups', 'side stripe', 'wide-leg', 'tapered', 'flared',
    'cropped', 'culottes', 'high-waisted', 'belted', 'piped seam', 'slim', 'pleated turn-ups', 'palazzo',
  ])
  assert.deepEqual([...WARDROBE.skirtCut], [
    'straight', 'pencil', 'A-line', 'pleated', 'box pleat', 'wrap', 'midi', 'midi pencil',
    'midi A-line', 'back vent', 'button front', 'tulip', 'panelled', 'high-waisted', 'belted', 'flared',
  ])
  assert.deepEqual(Object.values(TROUSER_CUT), WARDROBE.trouserCut.map((_, i) => i), 'TROUSER_CUT names the list in order')
  assert.deepEqual(Object.values(SKIRT_CUT), WARDROBE.skirtCut.map((_, i) => i), 'SKIRT_CUT names the list in order')
  for (const name of [...WARDROBE.trouserCut, ...WARDROBE.skirtCut]) assert.doesNotMatch(name, PEOPLE, `${name}: a cut is named for itself`)
  for (const b of BODIES) {
    assert.deepEqual(lookOptions(b, 'bottomCut').map((o) => o.name), b === 3 ? [...WARDROBE.skirtCut] : [...WARDROBE.trouserCut])
    assert.equal(BOTTOM_CUT_STREET[b].length, 8)
    assert.equal(new Set(BOTTOM_CUT_STREET[b]).size, 8)
    assert.ok(!BOTTOM_CUT_STREET[b].includes(0), 'the street\'s cuts are cuts')
    for (const [i, c] of BOTTOM_CUT_STREET[b].entries()) assert.equal((BOTTOM_CUT_STREET_PACKED[b] >>> (4 * i)) & 15, c)
  }
  assert.ok(BOTTOM_CUT_STREET[0].includes(TROUSER_CUT.crease) && BOTTOM_CUT_STREET[2].includes(TROUSER_CUT.wideLeg) && BOTTOM_CUT_STREET[3].includes(SKIRT_CUT.pencil))
  assert.equal(LOOK_ODDS.bottomCut, 0.65)
  // The cut stays across the three trouser bodies; between them and the skirt suit it starts again at straight.
  const pleated = withLookSlot(zero(0), 'bottomCut', TROUSER_CUT.pleated)!
  assert.equal(withLookSlot(pleated, 'body', 1)!.bottomCut, TROUSER_CUT.pleated)
  assert.equal(withLookSlot(pleated, 'body', 2)!.bottomCut, TROUSER_CUT.pleated)
  assert.equal(withLookSlot(pleated, 'body', 3)!.bottomCut, 0, 'pleated trousers are no skirt\'s cut')
  assert.equal(withLookSlot(withLookSlot(zero(3), 'bottomCut', SKIRT_CUT.midi)!, 'body', 0)!.bottomCut, 0)
  assert.equal(withLookSlot(zero(0), 'bottomCut', 16), null)
  // By name, on the body it fits: "a-line" is the skirt's, "wide-leg" the trousers'.
  assert.equal(changeLook(zero(3), { kind: 'slot', slot: 'bottomCut', value: 'a-line' }, 0).look?.bottomCut, SKIRT_CUT.aLine)
  assert.equal(changeLook(zero(2), { kind: 'slot', slot: 'bottomCut', value: 'wide-leg' }, 0).look?.bottomCut, TROUSER_CUT.wideLeg)
  assert.ok(changeLook(zero(0), { kind: 'slot', slot: 'bottomCut', value: 'pencil' }, 0).error)
  // The code carries it; a look kept before the cut wears the straight leg.
  for (const b of BODIES) for (let c = 0; c < 16; c++) assert.equal(parseLookCode(formatLookCode(withLookSlot(zero(b), 'bottomCut', c)!))?.bottomCut, c)
  // crowd.ts reads the same word, links and lists in both stages, and hands the vertex stage the cut and the coat.
  assert.ok(CROWD.includes('const bottomCutNow = select(custom, genomeQuad.y.shiftRight(uint(LOOK_FIELD.bottomCut[1])).bitAnd(uint(15)), hashedBottomCut)'))
  assert.ok(CROWD.includes('uint(BOTTOM_CUT_STREET_PACKED[variant]).shiftRight(uint(hc(LOOK_HASHED_COLOUR.bottomCutPick).mul(8 - 0.001)).mul(uint(4))).bitAnd(uint(15)), uint(0))'), 'the vertex stage draws the hashed cut as the fragment does')
  assert.ok(CROWD.includes('const lowerCode = float(bottomCutNow).add(select(layer.equal(uint(LAYER.coat)), float(16), float(0)))'))
  assert.ok(CROWD.includes("const morphB = vec4(slider('legs'), slider('posture'), slider('head'), lowerCode)"))
  assert.ok(CROWD.includes('const streetBottomCut = uint(BOTTOM_CUT_STREET_PACKED[variant]).shiftRight(uint(h(LOOK_HASHED_COLOUR.bottomCutPick).mul(8 - 0.001)).mul(uint(4))).bitAnd(uint(15))'))
  assert.ok(CROWD.includes('const bottomCut = select(custom, gene(LOOK_FIELD.bottomCut), select(h(LOOK_HASHED_COLOUR.bottomCut).greaterThanEqual(LOOK_ODDS.bottomCut), streetBottomCut, uint(0))).toVar()'))
  assert.ok(CROWD.includes('const shared = [footprint, ...links.values(), cut, bottomCut,'), 'read in several branches: declared with the shared values')
  assert.ok(CROWD.includes('const slots: V3[] = [worn, shirt, select(turtleNeck, knitShirt, select(watchHere, watchColour, select(armHere, limbColour, skinShown))), hairShown, bottomShown,'), 'the bottom\'s slot paints the cut')
  assert.deepEqual([LOOK_HASHED_COLOUR.bottomCut, LOOK_HASHED_COLOUR.bottomCutPick], [36, 37])
  // The shorter trousers end where humanoid.ts says; below the culottes' hem, the cone back to the calf is its inside.
  assert.ok(CROWD.includes('select(lowIs(TROUSER_CUT.cropped), float(LOWER_PAINT.croppedHem), select(lowIs(TROUSER_CUT.culottes), float(LOWER_PAINT.culottesHem), float(-1)))'))
  assert.ok(CROWD.includes('const inside = ankle.and(lowIs(TROUSER_CUT.culottes)).and(rest.y.greaterThan(LOWER_PAINT.culottesInside))'))
  // The raised waist is woven as the trousers' seat is; the belt runs over the thighs' tops at the hips too.
  assert.ok(CROWD.includes('rig, select(raisedWaist, float(SLOT.BOTTOM), slot), footprint, near, variant === 3)'))
  assert.ok(CROWD.includes('const belt = lowIs(TROUSER_CUT.belted).and(waistShown).and(onTrunk.or(onLegBone))'))
})

test('the lower garments: twenty, twelve pairs of trousers and eight skirts, named by what they are; each sets the lower cut and the bottom\'s weave on the bodies it fits and is refused on the others; with the forty-four tops, sixty-four garments', () => {
  assert.equal(LOOK_LOWER_GARMENTS.length, 20)
  assert.equal(LOOK_GARMENTS.length + LOOK_LOWER_GARMENTS.length, 64)
  assert.equal(LOOK_LOWER_GARMENTS.filter((g) => g.skirt).length, 8)
  assert.ok(Object.isFrozen(LOOK_LOWER_GARMENTS))
  const names = new Set(LOOK_GARMENTS.map((g) => g.name))
  for (const g of LOOK_LOWER_GARMENTS) {
    assert.match(g.name, /^[A-Za-z][A-Za-z -]*[a-z]$/, `${g.name}: ASCII words`)
    assert.ok(!names.has(g.name), `${g.name} is unique among the sixty-four`)
    names.add(g.name)
    assert.doesNotMatch(g.name, PEOPLE, `${g.name}: a garment is named for itself`)
    assert.match(g.name, g.skirt ? /skirt$/ : /trousers$|chinos$|culottes$/, 'the name says what it is')
    assert.ok(g.bottomCut > 0 && g.bottomCut < 16 && g.bottomWeave >= 0 && g.bottomWeave < WARDROBE.weave.length)
    assert.equal(lookLowerGarment(` ${g.name.toUpperCase()} `), g, 'case and space ignored')
    assert.equal(lookGarment(g.name), null, 'no top by that name')
    for (const b of BODIES) {
      const base = lookFromSeed(b)
      const worn = withGarment(base, g.name)
      assert.equal(lowerGarmentFits(base, g), g.skirt === (b === 3))
      if (!lowerGarmentFits(base, g)) {
        assert.equal(worn, null, `${g.name} is refused on body ${b}`)
        const error = changeLook(base, { kind: 'garment', name: g.name }, 0).error ?? ''
        assert.match(error, g.skirt ? /goes with the skirt suit: this body wears trousers/ : /are trousers: the skirt suit wears a skirt/)
        continue
      }
      assert.ok(worn, `${g.name} on body ${b}`)
      assert.deepEqual(validateLook(worn), worn)
      assert.deepEqual([worn.bottomCut, worn.bottomWeave], [g.bottomCut, g.bottomWeave])
      for (const slot of LOOK_SLOTS) if (slot !== 'bottomCut' && slot !== 'bottomWeave') assert.equal(worn[slot], base[slot], `${g.name} keeps ${slot}`)
      assert.equal(lowerGarmentOf(worn)?.name, g.name, 'lowerGarmentOf finds it back')
      assert.equal(parseLookCode(formatLookCode(worn))?.bottomCut, g.bottomCut, 'the code carries the lower cut')
    }
  }
  assert.equal(lowerGarmentOf(zero(0)), null, 'the straight leg is no garment')
  assert.match(changeLook(lookFromSeed(0), { kind: 'garment', name: 'cape' }, 0).error ?? '', /no garment named 'cape': .*quilted coat, pinstripe suit trousers, .*button-front skirt$/)
})

// --- The accessory word --------------------------------------------------------------------------------------

/** The accessory word's slots (word 6): the shoe's style, the frames' finish, the watch, the lapel pin. */
const ACCESSORIES = ['footwear', 'frames', 'watch', 'lapelPin'] as const satisfies readonly LookSlot[]
/** A look with the accessory word's slots, and the tattoo word's after them, all at 0: what it was before they existed. */
const unadorned = (look: Look): Look => ({ ...look, footwear: 0, frames: 0, watch: 0, lapelPin: 0, tattooHand: 0, tattooHandR: 0, tattooNeck: 0, tattooNape: 0, tattooInk: 0, sleeves: 0, tattooForearm: 0, tattooForearmR: 0 })
/** A code's symbols, the dashes left out. */
const symbolCount = (code: string): number => code.replaceAll('-', '').length

test('the accessory word\'s option 0 is as before: every preset, every bare look and every hashed look without them packs word 6 to zero and keeps a code of the older lengths; the older codes still read; a record without the four keys is accepted', () => {
  const looks: Look[] = [...LOOK_PRESETS.map((p) => p.look), ...BODIES.map(zero)]
  for (let s = 0; s < 400; s++) looks.push(unadorned(lookFromSeed(s)))
  for (const look of looks) {
    assert.equal(packGenome(look)[6], 0, 'the accessory word is zero')
    assert.ok([28, 36, 43].includes(symbolCount(formatLookCode(look))), formatLookCode(look))
    assert.deepEqual(parseLookCode(formatLookCode(look)), look)
  }
  for (const p of LOOK_PRESETS) for (const slot of ACCESSORIES) assert.equal(p.look[slot], 0, `${p.name} wears no ${slot}`)
  // The codes pinned above, written before the accessory word existed, read back as they did.
  assert.deepEqual(parseLookCode('0B00144-S63RGY0-3RGY4R0-0000036'), LOOK_PRESETS[0].look)
  assert.deepEqual(parseLookCode('0P20HH8-S2409F8-9EXNA40-000027V-00M0W0E3'), lookFromSeed(0))
  // A record kept before the accessory word (no key for any of its slots) reads as the look with them at 0.
  const kept: Record<string, number> = { ...lookFromSeed(1) }
  for (const slot of ACCESSORIES) delete kept[slot]
  assert.deepEqual(validateLook(kept), unadorned(lookFromSeed(1)))
  assert.equal(lookFromSeed(1).footwear, FOOTWEAR.wingtip, 'and the hashed look keeps its own')
})

test('the accessory word round-trips every option of its four slots on every body, alone in word 6; such a code is forty-nine symbols, 7-7-7-7-8-8-5; a word-6 bit no field holds is refused', () => {
  for (const b of BODIES) {
    const bare = packGenome(zero(b))
    for (const slot of ACCESSORIES) {
      const [word, shift, width] = LOOK_FIELD[slot]
      assert.equal(word, 6)
      for (let v = 0; v < lookSize(b, slot); v++) {
        const look = withLookSlot(zero(b), slot, v)!
        assert.ok(look, `${LOOK_BODIES[b]} ${slot} ${v}`)
        const genome = packGenome(look)
        assert.equal(genome[6], (v << shift) >>> 0, `${slot} ${v} in word 6 alone, at bit ${shift}`)
        assert.ok(v < 1 << width)
        assert.deepEqual(genome.slice(0, 6), bare.slice(0, 6), 'words 0 to 5 are the bare look\'s')
        assert.deepEqual(genome.slice(7), bare.slice(7), 'and the spare words stay zero')
        assert.deepEqual(unpackGenome(genome), look)
        assert.deepEqual(parseLookCode(formatLookCode(look)), look)
        if (v > 0) assert.equal(symbolCount(formatLookCode(look)), 49)
      }
    }
  }
  const chronograph = withLookSlot(zero(0), 'watch', WATCH.tourbillon)!
  const code = formatLookCode(chronograph)
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{7}-[0-9A-HJKMNP-TV-Z]{7}-[0-9A-HJKMNP-TV-Z]{7}-[0-9A-HJKMNP-TV-Z]{7}-[0-9A-HJKMNP-TV-Z]{8}-[0-9A-HJKMNP-TV-Z]{8}-[0-9A-HJKMNP-TV-Z]{5}$/, code)
  assert.equal(symbolCount(code), 49)
  // Every slot at its last option together still round-trips.
  const all = validateLook({ ...zero(3), footwear: 11, frames: 7, watch: 4, lapelPin: 3 })!
  assert.deepEqual(parseLookCode(formatLookCode(all)), all)
  assert.equal(packGenome(all)[6], 11 | (7 << 5) | (4 << 9) | (3 << 12))
  // A bit of word 6 past the fields (a later slice's, or a forgery) is refused, as an older reader refuses this slice's.
  const forged = [...packGenome(chronograph)]
  forged[6] = (forged[6] | (1 << 15)) >>> 0
  assert.equal(unpackGenome(forged), null, 'bit 15 is no field\'s yet')
  assert.equal(unpackGenome([...packGenome(zero(0)).slice(0, 6), 1 << 31]), null)
  // Each slot past its options is refused, in the record and in the word.
  for (const slot of ACCESSORIES) assert.equal(withLookSlot(zero(1), slot, lookSize(1, slot)), null, `${slot} past its options`)
  assert.equal(unpackGenome([...packGenome(zero(0)).slice(0, 6), 12]), null, 'a thirteenth shoe style')
  assert.equal(unpackGenome([...packGenome(zero(0)).slice(0, 6), 5 << 9]), null, 'a sixth watch')
  // A body change keeps them: every body has the same lists.
  assert.deepEqual(withLookSlot(all, 'body', 0)!.footwear, 11)
  assert.deepEqual(withLookSlot(all, 'body', 0)!.lapelPin, 3)
})

test('the accessory tables: the street\'s shoe styles are styles, packed as crowd.ts reads them; each style its own set of features, the plain shoe none; the black frame the crowd\'s own; the names say what each is', () => {
  assert.deepEqual(Object.keys(FOOTWEAR).map((_, i) => i), Object.values(FOOTWEAR), 'FOOTWEAR names the list in order')
  assert.equal(Object.keys(FOOTWEAR).length, WARDROBE.footwear.length)
  assert.equal(FOOTWEAR.plain, 0, 'the plain shoe is 0: a look kept before the styles is shod as it was')
  for (const b of BODIES) {
    assert.equal(FOOTWEAR_STREET[b].length, 8)
    for (const [i, f] of FOOTWEAR_STREET[b].entries()) {
      assert.ok(f >= 1 && f <= 11, `${LOOK_BODIES[b]}: a style, not the plain shoe (${f})`)
      assert.equal((FOOTWEAR_STREET_PACKED[b] >>> (4 * i)) & 15, f)
    }
  }
  assert.deepEqual([...FOOTWEAR_STREET_PACKED], [0x65431122, 0xa9537744, 0x19728844, 0x2649bb88])
  assert.deepEqual({ ...FOOTWEAR_FEATURES }, { laces: 1166, cap: 68, wing: 8, loafer: 16, strap: 32, twoTone: 64, sneaker: 128, flat: 256, shaft: 3584, kneeShaft: 2048 })
  const features = (style: number): string => Object.entries(FOOTWEAR_FEATURES).filter(([, set]) => ((set >>> style) & 1) === 1).map(([name]) => name).join('+')
  assert.equal(features(FOOTWEAR.plain), '', 'the plain shoe is painted with nothing')
  const sets = new Set<string>()
  for (let style = 1; style < WARDROBE.footwear.length; style++) {
    assert.notEqual(features(style), '', `${WARDROBE.footwear[style]} is painted`)
    assert.ok(!sets.has(features(style)), `${WARDROBE.footwear[style]} is drawn unlike every other style`)
    sets.add(features(style))
  }
  for (const set of Object.values(FOOTWEAR_FEATURES)) assert.equal(set >>> WARDROBE.footwear.length, 0, 'no feature names a style that does not exist')
  assert.deepEqual(FRAME_FINISH[0], [0.05, 0.05, 0.055], 'black is the frame the crowd always painted')
  assert.ok(CROWD.includes('vec3(0.05, 0.05, 0.055)'), 'crowd.ts\'s black, the same')
  // The card's silhouette rounds each finish to a byte (Customizer.tsx silhouettePaint, pinned in lookWiring.test.ts).
  assert.equal(FRAME_FINISH[0].reduce((n, c) => n * 256 + Math.round(255 * c), 0), 0x0d0d0e, 'the card\'s black rims as before')
  assert.equal(FRAME_FINISH.length, WARDROBE.frames.length)
  assert.deepEqual(FRAME_FINISH[FRAMES.browline], FRAME_FINISH[FRAMES.black], 'a browline\'s upper rim is black')
  for (const c of [...FRAME_FINISH, TORTOISE_LIGHT]) assert.ok(c.length === 3 && c.every((v) => v >= 0 && v <= 1), 'linear RGB')
  assert.deepEqual(Object.values(FRAMES), WARDROBE.frames.map((_, i) => i), 'FRAMES names the list in order')
  assert.deepEqual(Object.values(WATCH), WARDROBE.watch.map((_, i) => i), 'WATCH names the list in order')
  assert.deepEqual(Object.values(LAPEL_PIN), WARDROBE.lapelPin.map((_, i) => i), 'LAPEL_PIN names the list in order')
  assert.ok(Object.isFrozen(FOOTWEAR_STREET) && Object.isFrozen(FRAME_FINISH) && Object.isFrozen(FOOTWEAR_FEATURES))
  // Named for what they are: never a people, never a place, never a maker.
  for (const slot of ACCESSORIES) {
    for (const name of WARDROBE[slot]) {
      assert.doesNotMatch(name, PEOPLE, `${name}: named for itself, never a people`)
      assert.match(name, /^[a-z][a-z -]*[a-z]$/, `${name}: lower-case ASCII words`)
    }
  }
})

// --- The tattoo word -------------------------------------------------------------------------------------------

/** The tattoo word's slots (word 7): the four zones of the hands, the neck and the nape, then their ink. */
const TATTOOS = ['tattooHand', 'tattooHandR', 'tattooNeck', 'tattooNape', 'tattooInk'] as const satisfies readonly LookSlot[]
/** A person's colours' chain, as lookFromSeed and the crowd's fragment stage take it. */
const coloursOf = (seed: number) => (k: number): number => shaderHash(Math.fround(Math.fround(seed) + Math.fround(k * LOOK_HASH.colours)))

test('the tattoo word round-trips every option of its five slots on every body, alone in word 7; a tattooed look\'s code is fifty-six symbols, 7-7-7-7-8-8-8-4; the street flag (bit 31) and a design past sixty-four are refused', () => {
  for (const b of BODIES) {
    const bare = packGenome(zero(b))
    for (const slot of TATTOOS) {
      const [word, shift, width] = LOOK_FIELD[slot]
      assert.equal(word, 7)
      for (let v = 0; v < lookSize(b, slot); v++) {
        const look = withLookSlot(zero(b), slot, v)!
        assert.ok(look, `${LOOK_BODIES[b]} ${slot} ${v}`)
        const genome = packGenome(look)
        assert.equal(genome[7], (v << shift) >>> 0, `${slot} ${v} in word 7 alone, at bit ${shift}`)
        assert.ok(v < 1 << width)
        assert.deepEqual(genome.slice(0, 7), bare.slice(0, 7), 'words 0 to 6 are the bare look\'s')
        assert.deepEqual(genome.slice(8), bare.slice(8), 'and the spare words stay zero')
        assert.deepEqual(unpackGenome(genome), look)
        const code = formatLookCode(look)
        assert.deepEqual(parseLookCode(code), look)
        if (v > 0) {
          assert.equal(symbolCount(code), 56)
          assert.equal(code.length, 63)
          assert.match(code, new RegExp(`^${SYMBOL}{7}-${SYMBOL}{7}-${SYMBOL}{7}-${SYMBOL}{7}-${SYMBOL}{8}-${SYMBOL}{8}-${SYMBOL}{8}-${SYMBOL}{4}$`), code)
        }
      }
    }
  }
  // Every zone inked and the last ink, on a Monk tone with a woven top, a cut and a watch: every later word in the tail.
  const all = validateLook({ ...lookFromSeed(2), tattooHand: 64, tattooHandR: 9, tattooNeck: 23, tattooNape: 3, tattooInk: 7, watch: WATCH.smartwatch })!
  assert.ok(all)
  assert.equal(packGenome(all)[7], (64 | (9 << 7) | (23 << 14) | (3 << 21) | (7 << 28)) >>> 0)
  assert.equal(packGenome(all)[7] >>> 31, 0, 'no worn look sets the street flag')
  assert.deepEqual(parseLookCode(formatLookCode(all)), all)
  assert.deepEqual(parseLookCode(formatLookCode(all).toLowerCase().replaceAll('-', ' ')), all)
  assert.equal(symbolCount(formatLookCode(all)), 56)
  // A carrier of the street keeps its tattoos in its code.
  assert.equal(formatLookCode(lookFromSeed(5)), '0DM518X-P8E8CEW-3YQRPV0-000004Q-0000300G-00000000-00000NG0-002R')
  assert.deepEqual(parseLookCode(formatLookCode(lookFromSeed(5))), lookFromSeed(5))
  // Word 7's bit 31 is the shader's street flag: a genome that sets it is refused, whatever else it holds.
  const flag = 1 << LOOK_STREET_FLAG.bit
  for (const look of [zero(0), all, lookFromSeed(5)]) {
    const forged = [...packGenome(look)]
    forged[LOOK_STREET_FLAG.word] = (forged[LOOK_STREET_FLAG.word] | flag) >>> 0
    assert.equal(unpackGenome(forged), null, 'the street flag is no look\'s')
  }
  assert.equal(unpackGenome([...packGenome(zero(0)).slice(0, 7), 0x80000000]), null)
  // A zone past the sixty-four designs is outside the wardrobe, in the record and in the word.
  for (const slot of TATTOOS) assert.equal(withLookSlot(zero(1), slot, lookSize(1, slot)), null, `${slot} past its options`)
  assert.equal(unpackGenome([...packGenome(zero(0)).slice(0, 7), 65]), null, 'a sixty-fifth design')
  assert.equal(unpackGenome([...packGenome(zero(0)).slice(0, 7), 127 << 21]), null, 'design 127 on the nape')
  // A record kept before the tattoo word (no key for any of its slots) reads as the look with them at 0.
  const kept: Record<string, number> = { ...lookFromSeed(5) }
  for (const slot of TATTOOS) delete kept[slot]
  assert.deepEqual(validateLook(kept), { ...lookFromSeed(5), tattooNape: 0 })
  // A body change keeps them: every body has the same lists.
  assert.equal(withLookSlot(all, 'body', 3)!.tattooHand, 64)
  assert.equal(withLookSlot(all, 'body', 3)!.tattooInk, 7)
})

test('the tattoo catalogue: sixty-four designs, eight families of eight, ids 1 to 12 the ink studio\'s forearm lines in catalogue order; the shader\'s tables packed from them; eight inks with their swatches; eight zones and their frames', () => {
  assert.equal(TATTOO_MOTIFS.length, 64)
  assert.deepEqual(TATTOO_MOTIFS.map((m) => m.id), Array.from({ length: 64 }, (_, i) => i + 1), 'a design\'s id is its zone slot\'s value')
  assert.deepEqual([...WARDROBE.tattoo], ['none', ...TATTOO_MOTIFS.map((m) => m.name)])
  assert.equal(new Set(WARDROBE.tattoo).size, 65, 'sixty-five names, each its own')
  assert.equal(TATTOO_STUDIO_LINES, 12)
  assert.deepEqual(TATTOO_MOTIFS.slice(0, 12).map((m) => m.name), [
    'olive branch', 'fibonacci spiral', 'braided rope band', 'circuit trace', 'star chart', 'scalloped arc band',
    'origami cranes', 'soundwave band', 'compass rose', 'botanical vine', 'euler identity', 'ocean wave band',
  ], 'the studio\'s twelve lines, in its catalogue\'s order')
  assert.deepEqual([...TATTOO_FAMILIES], ['flowers', 'stars and rays', 'circles and orbits', 'shapes', 'bands', 'spirals', 'sprigs', 'pictures'])
  const cells = new Set<string>()
  for (const m of TATTOO_MOTIFS) {
    assert.ok(m.family >= 0 && m.family < 8 && m.variant >= 0 && m.variant < 8 && m.tile >= 0 && m.tile < 4, m.name)
    assert.equal(m.entry, (m.family << 5) | (m.variant << 2) | m.tile, m.name)
    assert.ok(!cells.has(`${m.family}/${m.variant}`), `${m.name}: a family's variant each`)
    cells.add(`${m.family}/${m.variant}`)
    assert.ok(Object.isFrozen(m))
  }
  assert.equal(cells.size, 64, 'every family has exactly eight variants')
  for (const [f, ids] of TATTOO_BY_FAMILY.entries()) assert.deepEqual(ids.map((id) => [TATTOO_MOTIFS[id - 1].family, TATTOO_MOTIFS[id - 1].variant]), Array.from({ length: 8 }, (_, v) => [f, v]))
  assert.deepEqual(TATTOO_BY_FAMILY[4], [3, 6, 8, 12, 4, 5, 43, 44], 'the bands: the studio\'s six, the heartbeat, the helix')
  // How each fills its zone: the bands wrap round the limb, the cranes stack three, the rest are one drawing.
  const wraps = TATTOO_MOTIFS.filter((m) => m.tile === TATTOO_TILE.wrap).map((m) => m.id)
  assert.deepEqual(wraps, [3, 4, 5, 6, 8, 10, 12, 43, 44])
  assert.deepEqual(TATTOO_MOTIFS.filter((m) => m.tile === TATTOO_TILE.three).map((m) => m.name), ['origami cranes'])
  assert.equal(TATTOO_MOTIFS.filter((m) => m.tile === TATTOO_TILE.two).length, 0)
  // The shader's tables (the reference WGSL's `tab`, `pts` and `st` and the street's `sets`), packed from these.
  assert.deepEqual([...TATTOO_MOTIF_PACKED], [0x9383a0c0, 0x8be28797, 0x8f40c720, 0xc080400, 0x1c181410, 0x302c2824, 0x443c3834, 0x54504c48, 0x64605c58, 0x74706c68, 0x9f9b7c78, 0xb0aca8a4, 0xc8bcb8b4, 0xd8d4d0cc, 0xece8e4dc, 0xfcf8f4f0])
  assert.deepEqual([...TATTOO_POINTS_PACKED], [
    0x96745609, 0x56ffeacb, 0x74ff968e, 0x43eb168e, 0x56ebff16, 0x674a0343, 0xff03e39c, 0x24aa998a, 0x2442a2c4, 0xc57e75ff, 0x256dff75, 0x8c8d7e65,
    0x7e6d6c7b, 0xff717bff, 0x15ffaa4a, 0x92715233, 0x15ffd5b3, 0xd7d5ff17, 0xa08a6a40, 0x9a5aff40, 0x8c6c6aff, 0x7e5cff8a, 0xed9bff9c, 0xffe99bff,
    0xad7e9454, 0x6484b7ca, 0x7e4d2a37, 0xff6264ff, 0x52ff8284, 0x52509092, 0x694b2b09, 0xffc9ab8b, 0xa4958574, 0x7d4c5b5, 0x89726b57, 0xffffe797,
  ])
  assert.deepEqual([...TATTOO_POINT_STARTS], [0, 13, 21, 31, 45, 72, 98, 120, 135, 142], 'the pictures, the heartbeat at 135 to 142')
  assert.deepEqual([...TATTOO_POINT_STARTS_PACKED], [0xd0000, 0x1f0015, 0x48002d, 0x780062, 0x8e0087])
  assert.equal(TATTOO_PICTURES.length, 8)
  for (const p of [...TATTOO_PICTURES.flat(), ...TATTOO_HEARTBEAT]) assert.ok((p[0] === 15 && p[1] === 15) || (p[0] >= 0 && p[0] <= 14 && p[1] >= 0 && p[1] <= 14), `point ${p} on the grid or the pen`)
  assert.deepEqual([...TATTOO_PEN], [15, 15])
  assert.deepEqual([...TATTOO_STREET_SETS], [1, 2, 4, 8, 16, 32, 48, 192])
  assert.deepEqual([...TATTOO_STREET_SETS_PACKED], [0x08040201, 0xc0302010])
  // The inks: eight, black first (as every tattoo was inked before a choice), each swatch its linear albedo in sRGB.
  assert.deepEqual([...WARDROBE.tattooInk], ['black', 'indigo', 'white', 'gold leaf', 'luminescent', 'brick red', 'forest green', 'grey wash'])
  assert.deepEqual(Object.values(TATTOO_INK), WARDROBE.tattooInk.map((_, i) => i), 'TATTOO_INK names the list in order')
  assert.deepEqual([...TATTOO_SHOP_INKS], [TATTOO_INK.goldLeaf, TATTOO_INK.luminescent], 'the studio\'s two inks')
  const toSrgb = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055))
  for (const ink of TATTOO_INKS) {
    assert.ok(ink.rgb.length === 3 && ink.rgb.every((c) => c >= 0 && c <= 1), `${ink.name}: linear RGB`)
    assert.equal(ink.hex, (toSrgb(ink.rgb[0]) << 16) | (toSrgb(ink.rgb[1]) << 8) | toSrgb(ink.rgb[2]), `${ink.name}: its swatch is its albedo`)
  }
  assert.deepEqual(TATTOO_INKS.map((i) => i.hex), [0x1d1d1f, 0x303861, 0xe7e5df, 0xcbb681, 0xc4f9e7, 0xa2453f, 0x387c55, 0x6f6f73])
  assert.deepEqual(TATTOO_INKS[TATTOO_INK.goldLeaf].rgb, FRAME_FINISH[FRAMES.goldTone], 'gold leaf is the gold tone the frames and the chronograph wear')
  // The zones: the slots in the shader's order, each on its bone and the person's own side; the wardrobe has the first
  // four (the hands, the neck, the nape), and the street draws all eight.
  assert.deepEqual(TATTOO_ZONES.map((z) => z.slot), ['tattooHand', 'tattooHandR', 'tattooNeck', 'tattooNape', 'tattooForearm', 'tattooForearmR', 'tattooCalf', 'tattooAnkleR'])
  assert.deepEqual(TATTOO_ZONES.map((z) => z.label), ['Left hand', 'Right hand', 'Neck', 'Nape', 'Left forearm', 'Right forearm', 'Left calf', 'Right ankle'])
  assert.deepEqual(TATTOO_ZONES.map((z) => z.bone), [BONE.HAND_R, BONE.HAND_L, BONE.HEAD, BONE.HEAD, BONE.FOREARM_R, BONE.FOREARM_L, BONE.SHIN_R, BONE.SHIN_L])
  assert.deepEqual(TATTOO_ZONES.map((z) => z.slice), [1, 1, 1, 1, 2, 2, 3, 3])
  assert.deepEqual(TATTOO_ZONES.filter((z) => (LOOK_SLOTS as readonly string[]).includes(z.slot)).map((z) => z.slot), [...LOOK_SLOTS.slice(49, 53), ...LOOK_SLOTS.slice(55, 57)], 'the hands\', the neck\'s, the nape\'s and the forearms\' zones are the wardrobe\'s')
  // The frames (zone order): the hands planar on their front face, the rest round an axis; each square inside its ring.
  assert.equal(TATTOO_FRAMES.length, 8)
  assert.deepEqual(TATTOO_FRAMES.map((f) => [f.axisX, f.centreY, f.half, f.radius, f.reps]), [
    [0.212, 0.835, 0.031, 0, 6], [-0.212, 0.835, 0.031, 0, 6], [0, 1.552, 0.021, 0.059, 9], [0, 1.578, 0.03, 0.058, 9],
    [0.212, 1.03, 0.045, 0.037, 4], [-0.212, 1.03, 0.045, 0.037, 4], [0.095, 0.3, 0.06, 0.056, 5], [-0.095, 0.125, 0.03, 0.043, 5],
  ])
  assert.deepEqual(TATTOO_FRAMES.map((f) => f.angle), [0, 0, 1.2, 3.1415927, 0, 0, 1.5707963, -1.5707963], 'the centre angles: the front, the front-left of the neck, the back, the legs\' outer sides, as the shader writes them')
  assert.deepEqual(TATTOO_FRAMES.map((f) => f.wrapY), [0.895, 0.895, 1.552, 1.578, 1.03, 1.03, 0.3, 0.125], 'the hands wrap at the wrist')
  assert.ok(TATTOO_FRAMES[2].centreY + TATTOO_FRAMES[2].half < TATTOO_HEAD_SPLIT.neckTop, 'the neck\'s square ends below the chin ring')
  assert.ok(TATTOO_FRAMES[3].centreY + TATTOO_FRAMES[3].half < TATTOO_HEAD_SPLIT.top, 'the nape\'s inside the head\'s zone')
  assert.ok(TATTOO_FRAMES[0].centreY + TATTOO_FRAMES[0].half < 0.898, 'the hand\'s one design clear of the watch band')
  assert.ok(TATTOO_FRAMES[4].centreY - TATTOO_FRAMES[4].half > 0.935 && TATTOO_FRAMES[4].centreY + TATTOO_FRAMES[4].half < 1.1, 'the forearm\'s between the cuff and the roll')
  assert.ok(TATTOO_FRAMES[7].centreY - TATTOO_FRAMES[7].half > 0.085, 'the ankle\'s above the shoe')
  assert.deepEqual({ ...TATTOO_HEAD_SPLIT }, { top: 1.62, napeZ: -0.035, neckTop: 1.575 })
  assert.ok(Object.isFrozen(TATTOO_MOTIFS) && Object.isFrozen(TATTOO_ZONES) && Object.isFrozen(TATTOO_FRAMES) && Object.isFrozen(TATTOO_INKS) && Object.isFrozen(TATTOO_PICTURES))
})

/** Words a tattoo's name must never hold: the declined designs of peoples and faiths, the house's refused words. */
const TATTOO_DENIED = /celtic|seigaiha|wayfinder|moko|haida|adinkra|rune|vegvisir|chakana|lotus|mandala|hamsa|skull|infinity|sierpinski|helm|target|matrix/i

test('tattoo names: lower-case ASCII words, never a people\'s, a culture\'s or a faith\'s, and none the house refuses; slot names fit the console\'s column', () => {
  for (const name of [...WARDROBE.tattoo, ...WARDROBE.tattooInk]) {
    assert.match(name, /^[a-z][a-z -]*[a-z]$/, `${name}: lower-case ASCII words`)
    assert.doesNotMatch(name, PEOPLE, `${name}: named for itself, never a people`)
    assert.doesNotMatch(name, TATTOO_DENIED, `${name}: a declined or refused word`)
    assert.ok(name.length <= 18, `${name}: short enough for a pill`)
  }
  assert.equal(Math.max(...TATTOO_MOTIFS.map((m) => m.name.length)), 18, 'archimedean spiral, the longest')
  for (const z of TATTOO_ZONES) {
    assert.match(z.slot, /^tattoo[A-Z][A-Za-z]*$/)
    assert.ok(z.slot.length <= 'prostheticFinish'.length, `${z.slot} fits the console's column`)
    assert.doesNotMatch(z.label, PEOPLE)
    assert.doesNotMatch(z.label, TATTOO_DENIED)
  }
  for (const word of ['celtic', 'seigaiha', 'wayfinder', 'infinity loop', 'sierpinski triangle', 'helm wheel']) assert.match(word, TATTOO_DENIED, 'the denylist holds what it names')
})

test('the street\'s tattoos: one person in five carries ink, one in ten on the hands, the neck or the nape; never a studio design or a studio ink; seeds 0 to 3 untattooed; lookFromSeed wears the street\'s zones the wardrobe has, and rolls its sleeves for a forearm unless it wears a coat', () => {
  const n = 20000
  let carriers = 0, shown = 0, worn = 0, rolled = 0
  const zones = new Array(8).fill(0)
  const inks = new Array(8).fill(0)
  for (let s = 0; s < n; s++) {
    const street = streetTattoos(coloursOf(s))
    assert.equal(street.motifs.length, 8)
    const inked = street.motifs.filter((m) => m > 0).length
    assert.ok(inked <= 2, 'one zone, or a pair')
    if (inked > 0) {
      carriers++
      inks[street.ink]++
      // The set is one of the street's, and its zones are exactly the inked ones.
      assert.ok(TATTOO_STREET_SETS.includes(street.motifs.reduce((set, m, z) => (m > 0 ? set | (1 << z) : set), 0)), `seed ${s}: a street set`)
    } else assert.equal(street.ink, TATTOO_INK.black, `seed ${s}: no ink without a tattoo`)
    for (const [z, m] of street.motifs.entries()) {
      if (m === 0) continue
      zones[z]++
      assert.ok(m > TATTOO_STUDIO_LINES && m <= 64, `seed ${s}: design ${m} is the street's, not the studio's`)
    }
    assert.ok(!TATTOO_SHOP_INKS.includes(street.ink), `seed ${s}: never the studio's ink`)
    if (street.motifs.slice(0, 4).some((m) => m > 0)) shown++
    const look = lookFromSeed(s)
    assert.deepEqual([look.tattooHand, look.tattooHandR, look.tattooNeck, look.tattooNape], street.motifs.slice(0, 4), `seed ${s}: the look wears the street's hands, neck and nape`)
    assert.deepEqual([look.tattooForearm, look.tattooForearmR], street.motifs.slice(4, 6), `seed ${s}: and its forearms`)
    assert.equal(look.tattooInk, street.motifs.slice(0, 6).some((m) => m > 0) ? street.ink : TATTOO_INK.black, `seed ${s}: the ink where one of them is inked`)
    assert.equal(look.sleeves, street.motifs.slice(4, 6).some((m) => m > 0) && look.layer !== LAYER.coat ? SLEEVES.rolled : SLEEVES.full, `seed ${s}: sleeves rolled for a forearm, never a coat's`)
    if (look.tattooHand + look.tattooHandR + look.tattooNeck + look.tattooNape > 0) worn++
    if (look.sleeves === SLEEVES.rolled) rolled++
  }
  const near = (got: number, want: number, name: string, tol: number) => assert.ok(Math.abs(got - want) < tol, `${name}: ${got.toFixed(4)} vs ${want}`)
  near(carriers / n, 0.2, 'carriers', 0.005)
  near(shown / n, 0.1005, 'on the hands, the neck or the nape', 0.005)
  near(worn / n, 0.1005, 'lookFromSeed\'s tattooed', 0.005)
  // Three forearm sets in eight carriers' (one forearm, the other, both), less the coats (LOOK_ODDS.coat: 15%).
  near(rolled / n, 0.2 * 3 / 8 * 0.85, 'rolled sleeves', 0.005)
  for (const z of [0, 1, 2, 3, 6, 7]) near(zones[z] / n, 0.025, `zone ${z}`, 0.004)
  for (const z of [4, 5]) near(zones[z] / n, 0.05, `forearm ${z}`, 0.005)
  near(inks[TATTOO_INK.black] / carriers, 0.7, 'black among carriers', 0.02)
  near(inks[TATTOO_INK.greyWash] / carriers, 0.14, 'grey wash among carriers', 0.015)
  // The player's slot and the first agents carry none, so their looks and codes are as they were.
  for (const s of [0, 1, 2, 3]) {
    assert.ok(coloursOf(s)(LOOK_HASHED_COLOUR.tattoo) < Math.fround(LOOK_ODDS.tattoo), `seed ${s} carries no ink`)
    assert.deepEqual(streetTattoos(coloursOf(s)).motifs, [0, 0, 0, 0, 0, 0, 0, 0])
  }
  // The first carriers, by zone, design and ink.
  const drawn = (s: number) => {
    const t = streetTattoos(coloursOf(s))
    return `${t.motifs.flatMap((m, z) => (m > 0 ? [`${TATTOO_ZONES[z].slot} ${WARDROBE.tattoo[m]}`] : [])).join(' + ')}, ${WARDROBE.tattooInk[t.ink]}`
  }
  assert.deepEqual([5, 8, 20, 32, 34, 35, 49, 55].map(drawn), [
    'tattooNape heartbeat line, black', 'tattooHandR atom, black', 'tattooNape anemone, black', 'tattooForearmR nested diamonds, black',
    'tattooHand anemone, black', 'tattooForearmR snail shell, black', 'tattooForearmR waxing crescent, indigo', 'tattooCalf storm spiral + tattooAnkleR snail shell, black',
  ])
  assert.equal([5, 8, 20, 32, 34, 35, 49, 55].map((s) => lookFromSeed(s)).filter((l) => l.tattooHand + l.tattooHandR + l.tattooNeck + l.tattooNape + l.tattooForearm + l.tattooForearmR > 0).length, 7, 'the calf waits for its slot')
  assert.equal(lookFromSeed(49).tattooInk, TATTOO_INK.indigo, 'a forearm\'s indigo is the look\'s ink now that the forearm has its slot')
  assert.equal(lookFromSeed(55).tattooInk, TATTOO_INK.black, 'the calf\'s and the ankle\'s wait for theirs')
})

/** linear RGB of an sRGB hex, as three's Color reads it. */
const linear = (hex: number): TattooRgb => {
  const c = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return [c(((hex >> 16) & 255) / 255), c(((hex >> 8) & 255) / 255), c((hex & 255) / 255)]
}

test('inkLine: every ink stands out from every skin the crowd wears by 3:1, as the line on the skin or against its halo; black on the deepest Monk tone takes a light halo', () => {
  // The skins: the Monk tones under the four undertones' tints (crowd.ts), young and grey with age, and vitiligo's pale.
  assert.ok(CROWD.includes('vec3(1.04, 1.0, 0.94)') && CROWD.includes('vec3(0.97, 0.99, 1.05)') && CROWD.includes('vec3(0.98, 1.02, 0.92)'), 'the undertones\' tints')
  assert.ok(CROWD.includes('const VITILIGO_PALE = new Color(0xf2e0d6)'))
  assert.ok(CROWD.includes('vec3(dot(marked, vec3(0.2126, 0.7152, 0.0722))), age.mul(0.25))'), 'age greys the skin by a quarter at most')
  const tints: TattooRgb[] = [[1, 1, 1], [1.04, 1.0, 0.94], [0.97, 0.99, 1.05], [0.98, 1.02, 0.92]]
  const skins: TattooRgb[] = [linear(0xf2e0d6)]
  for (const hex of LOOK_PALETTE.monk) for (const tint of tints) for (const age of [0, 1]) {
    const c = linear(hex).map((v, i) => v * tint[i]) as unknown as TattooRgb
    const g = tattooLuminance(c)
    skins.push(c.map((v) => v + (g - v) * age * 0.25) as unknown as TattooRgb)
  }
  assert.equal(skins.length, 81)
  const haloed = TATTOO_INKS.map(() => 0)
  for (const [i] of TATTOO_INKS.entries()) {
    for (const skin of skins) {
      const r = inkLine(skin, i)
      assert.deepEqual(r.line, skin.map((v, c) => v + (TATTOO_INKS[i].rgb[c] - v) * TATTOO_HALO.mix))
      const li = tattooLuminance(r.line)
      const against = r.t > 0 ? tattooLuminance(r.halo) : tattooLuminance(skin)
      assert.ok(tattooContrast(li, against) >= TATTOO_HALO.contrast - 1e-9, `${TATTOO_INKS[i].name} on ${skin}: ${tattooContrast(li, against)}`)
      assert.ok(r.t >= 0 && r.t <= 1)
      if (r.t > 0) {
        haloed[i]++
        assert.ok(tattooContrast(li, tattooLuminance(skin)) < TATTOO_HALO.contrast, 'a halo only where the line alone would not do')
        assert.ok(Math.abs(tattooContrast(li, against) - TATTOO_HALO.contrast) < 1e-9, 'the halo goes just far enough')
      } else assert.deepEqual(r.halo, skin)
    }
  }
  assert.deepEqual(haloed, [32, 40, 49, 57, 47, 48, 56, 56], 'haloed skins of the eighty-one, per ink')
  // Black on MST-10: the line barely darker than the skin, so a light halo carries it.
  const deepest = linear(LOOK_PALETTE.monk[9])
  const black = inkLine(deepest, TATTOO_INK.black)
  assert.equal(tattooLuminance(deepest).toFixed(4), '0.0184')
  assert.equal(tattooLuminance(black.line).toFixed(4), '0.0128')
  assert.equal(black.t.toFixed(4), '0.1257')
  assert.equal(tattooLuminance(black.halo).toFixed(4), '0.1383')
  // Black on MST-01 needs none; white on MST-01 takes a dark halo; an unknown ink is black.
  assert.equal(inkLine(linear(LOOK_PALETTE.monk[0]), TATTOO_INK.black).t, 0)
  const white = inkLine(linear(LOOK_PALETTE.monk[0]), TATTOO_INK.white)
  assert.ok(white.t > 0 && tattooLuminance(white.halo) < tattooLuminance(linear(LOOK_PALETTE.monk[0])), 'toward the brown-black')
  assert.deepEqual(inkLine(deepest, 99), black)
  assert.ok(tattooLuminance(TATTOO_HALO.white) > tattooLuminance(linear(LOOK_PALETTE.monk[0])) && tattooLuminance(TATTOO_HALO.black) < tattooLuminance(deepest), 'both poles past every skin tone')
})

test('changeLook names a tattoo by its design or its 1-based number, none clears a zone, the ink by its name; a design not in the catalogue is refused with the range, not sixty-five names', () => {
  const suit = LOOK_PRESETS[0].look
  const ok = (r: ReturnType<typeof changeLook>): Look => { assert.equal(r.error, null, r.error ?? ''); return r.look! }
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'tattooHand', value: 'compass rose' }, 0)).tattooHand, 9)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'tattooHand', value: '10' }, 0)).tattooHand, 9, 'option 10 is design 9')
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'tattooNape', value: 'Braided Rope Band' }, 0)).tattooNape, 3)
  assert.equal(ok(changeLook({ ...suit, tattooNape: 3 }, { kind: 'slot', slot: 'tattooNape', value: 'none' }, 0)).tattooNape, 0)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'tattooneck', value: 'gulls in flight' }, 0)).tattooNeck, 64)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'tattooInk', value: 'gold leaf' }, 0)).tattooInk, TATTOO_INK.goldLeaf)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'tattooInk', value: '5' }, 0)).tattooInk, TATTOO_INK.luminescent)
  for (const [change, why] of [
    [{ kind: 'slot', slot: 'tattooHand', value: 'dragon' }, /^no tattooHand named 'dragon': 1-65 or a design's name \(Tab completes them\)$/],
    [{ kind: 'slot', slot: 'tattooHandR', value: '0' }, /^tattooHandR has 65 options \(1-65\)$/],
    [{ kind: 'slot', slot: 'tattooNape', value: '66' }, /^tattooNape has 65 options \(1-65\)$/],
    [{ kind: 'slot', slot: 'tattooInk', value: 'teal' }, /^no tattooInk named 'teal': black, indigo, white, gold leaf, luminescent, brick red, forest green, grey wash$/],
  ] as const) {
    const r = changeLook(suit, change, 0)
    assert.equal(r.look, null)
    assert.match(r.error ?? '', why)
  }
  // The hair styles' thirty-two still list their names: the range is the designs' alone.
  assert.match(changeLook(suit, { kind: 'slot', slot: 'hairStyle', value: 'quiff' }, 0).error ?? '', /: short, long, bob, bun, bald, buzz cut/)
  // describeLook prints a zone's design and the ink like any other slot.
  const lines = describeLook({ ...suit, tattooHand: 9, tattooInk: 3 })
  assert.equal(lines[LOOK_SLOTS.indexOf('tattooHand')], 'tattooHand       compass rose  [10/65]')
  assert.equal(lines[LOOK_SLOTS.indexOf('tattooNape')], 'tattooNape       none  [1/65]')
  assert.equal(lines[LOOK_SLOTS.indexOf('tattooInk')], 'tattooInk        gold leaf  [4/8]')
})

test('tattooCover says what hides a zone in the city, as the crowd\'s own gates do: the limb on its side, the cup over the right hand, a turtleneck under a jacket or a coat over the neck, sleeves down or a coat over a forearm', () => {
  const suit = { ...LOOK_PRESETS[0].look, cup: 0, prosthetic: PROSTHETIC.none }
  const zones = ['tattooHand', 'tattooHandR', 'tattooNeck', 'tattooNape'] as const
  const arms = ['tattooForearm', 'tattooForearmR'] as const
  const forearms = (look: Look) => arms.map((z) => tattooCover(look, z))
  // A forearm shows below sleeves rolled to the elbow, never under a coat; a prosthetic arm on its side covers it first.
  assert.equal(suit.layer, LAYER.jacket)
  assert.deepEqual(forearms(suit), ['roll the sleeves to show it', 'roll the sleeves to show it'], 'sleeves down, as before')
  assert.deepEqual(forearms({ ...suit, sleeves: SLEEVES.rolled }), [null, null])
  assert.deepEqual(forearms({ ...suit, sleeves: SLEEVES.rolled, layer: LAYER.shirt }), [null, null], 'shirt sleeves roll too')
  assert.deepEqual(forearms({ ...suit, sleeves: SLEEVES.rolled, layer: LAYER.coat }), ['a coat keeps its sleeves down', 'a coat keeps its sleeves down'])
  assert.deepEqual(forearms({ ...suit, sleeves: SLEEVES.rolled, prosthetic: PROSTHETIC.leftArm }), ['covered by the limb', null])
  assert.deepEqual(forearms({ ...suit, sleeves: SLEEVES.rolled, prosthetic: PROSTHETIC.rightArm }), [null, 'covered by the limb'])
  assert.deepEqual(forearms({ ...suit, layer: LAYER.coat, prosthetic: PROSTHETIC.bothArms }), ['covered by the limb', 'covered by the limb'], 'the limb is named before the coat')
  const covers = (look: Look) => zones.map((z) => tattooCover(look, z))
  assert.deepEqual(covers(suit), [null, null, null, null], 'nothing covers a bare look')
  // A prosthetic arm on the person's left covers the left hand (bone HAND_R, crowd.ts armHere), on the right the right hand, both arms both.
  assert.deepEqual(covers({ ...suit, prosthetic: PROSTHETIC.leftArm }), ['covered by the limb', null, null, null])
  assert.deepEqual(covers({ ...suit, prosthetic: PROSTHETIC.rightArm }), [null, 'covered by the limb', null, null])
  assert.deepEqual(covers({ ...suit, prosthetic: PROSTHETIC.bothArms }), ['covered by the limb', 'covered by the limb', null, null])
  for (const leg of [PROSTHETIC.leftLeg, PROSTHETIC.rightLeg, PROSTHETIC.bothLegs]) assert.deepEqual(covers({ ...suit, prosthetic: leg }), [null, null, null, null], 'a leg covers no zone of these four')
  // The cup is held over the right hand's back; the limb is named first where both are.
  assert.deepEqual(covers({ ...suit, cup: 1 }), [null, 'the cup covers it', null, null])
  assert.deepEqual(covers({ ...suit, cup: 1, prosthetic: PROSTHETIC.rightArm }), [null, 'covered by the limb', null, null])
  // A turtleneck knits up the neck under a jacket or a coat; under shirt sleeves there is no turtleneck.
  assert.equal(WARDROBE.cut[CUT.turtleneck], 'turtleneck')
  for (const layer of [LAYER.jacket, LAYER.coat]) assert.deepEqual(covers({ ...suit, cut: CUT.turtleneck, layer }), [null, null, 'the turtleneck covers it', null], `layer ${layer}`)
  assert.deepEqual(covers({ ...suit, cut: CUT.turtleneck, layer: LAYER.shirt }), [null, null, null, null])
  for (const cut of [CUT.band, CUT.zip, CUT.notch]) assert.deepEqual(covers({ ...suit, cut }), [null, null, null, null], `cut ${cut}`)
  for (const slot of LOOK_SLOTS.filter((x) => !([...zones, ...arms] as readonly string[]).includes(x))) assert.equal(tattooCover({ ...suit, cup: 1, prosthetic: PROSTHETIC.bothArms, cut: CUT.turtleneck }, slot), null, slot)
  // The gates it names are the shader's: the arm by side (the hand, and the forearm a rolled sleeve bares), the
  // sleeves rolled but never under a coat, the turtleneck's cut and layer.
  assert.ok(CROWD.includes('const armHere = armSide(BONE.HAND_R, positionGeometry.x.greaterThan(0)).and(limb(PROSTHETIC.leftArm, PROSTHETIC.bothArms))\n      .or(armSide(BONE.HAND_L, positionGeometry.x.lessThan(0)).and(limb(PROSTHETIC.rightArm, PROSTHETIC.bothArms)))'))
  assert.ok(CROWD.includes('gene(LOOK_FIELD.sleeves).equal(uint(SLEEVES.rolled))') && CROWD.includes('.and(layer.notEqual(uint(LAYER.coat)))'))
  assert.ok(CROWD.includes('const turtleNeck = cutIs(CUT.turtleneck).and(layer.notEqual(uint(LAYER.shirt)))'))
  assert.equal(TATTOO_ZONES[0].bone, BONE.HAND_R, 'the left hand is bone HAND_R')
  assert.equal(TATTOO_ZONES[1].bone, BONE.HAND_L, 'the right hand, which holds the cup, is bone HAND_L')
})

// --- Presets ---------------------------------------------------------------------------------------------------

test('every preset validates, names are unique ASCII words, every body is dressed, and lookPreset finds them', () => {
  assert.ok(LOOK_PRESETS.length >= 8)
  assert.ok(Object.isFrozen(LOOK_PRESETS))
  const names = new Set<string>()
  const bodies = new Set<number>()
  const styles = new Set<number>()
  const layers = new Set<number>()
  for (const p of LOOK_PRESETS) {
    assert.match(p.name, /^[a-z][a-z ]*[a-z]$/)
    assert.ok(!names.has(p.name), p.name)
    names.add(p.name)
    assert.deepEqual(validateLook(p.look), p.look)
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.look))
    bodies.add(p.look.body)
    styles.add(p.look.hairStyle)
    layers.add(p.look.layer)
    assert.deepEqual(unpackLook(...words(p.look)), p.look)
    assert.deepEqual(lookPreset(p.name), p)
    assert.deepEqual(lookPreset(` ${p.name.toUpperCase()} `), p)
    assert.ok(statureOf(p.look.height) >= 1.6 && statureOf(p.look.height) <= 1.9, `${p.name} stands ${statureOf(p.look.height)} m`)
    for (const f of LOOK_FACE_SLIDERS) assert.ok(p.look[f] >= 5 && p.look[f] <= 11, `${p.name}'s ${f} is a face, not a caricature`)
  }
  assert.equal(bodies.size, 4)
  assert.equal(styles.size, 5, 'every hair style is shown by a preset')
  assert.ok(layers.has(LAYER.jacket) && layers.has(LAYER.coat), 'a jacket and a coat are shown by presets')
  assert.ok(!layers.has(LAYER.shirt), 'no preset named for its jacket takes it off')
  assert.ok(LOOK_PRESETS.some((p) => p.look.trim > 0) && LOOK_PRESETS.some((p) => p.look.scarf > 0), 'a trim and a scarf are shown')
  assert.ok(LOOK_PRESETS.filter((p) => p.look.layer === LAYER.jacket && p.look.trim === 0 && p.look.scarf === 0).length >= 2, 'and plain looks too')
  assert.equal(lookPreset('tuxedo'), null)
  assert.equal(lookPreset(''), null)
})

// --- Face shapes -----------------------------------------------------------------------------------------------

test('the face shapes: twenty-four named by shape alone over the head and the seven face sliders; a shape sets those eight alone; faceShapeNameOf names it until a slider moves', () => {
  assert.equal(LOOK_FACE_SHAPES.length, 24)
  assert.deepEqual([...LOOK_FACE_SHAPE_SLIDERS], ['head', ...LOOK_FACE_SLIDERS])
  assert.ok(Object.isFrozen(LOOK_FACE_SHAPES))
  assert.equal(LOOK_FACE_SHAPES[0].name, 'oval')
  assert.deepEqual(LOOK_FACE_SHAPES[0].steps, { head: 4, brow: 8, jaw: 8, chin: 8, cheek: 8, nose: 8, eyes: 8, lips: 8 }, 'the oval is the base face')
  const seen = new Set<string>()
  for (const f of LOOK_FACE_SHAPES) {
    assert.ok(Object.isFrozen(f) && Object.isFrozen(f.steps))
    // A shape's words name the shape and its features, never a people (the slider sets are not anyone's ancestry).
    for (const word of f.name.split(' ')) assert.ok(['oval', 'round', 'square', 'heart', 'long', 'diamond', 'triangle', 'rectangle', 'soft', 'defined', 'full', 'broad', 'narrow', 'nose', 'lips', 'wide', 'eyes'].includes(word), `${f.name}: ${word}`)
    for (const sl of LOOK_FACE_SHAPE_SLIDERS) assert.ok(Number.isInteger(f.steps[sl]) && f.steps[sl] >= 0 && f.steps[sl] < (sl === 'head' ? WARDROBE.headSteps : WARDROBE.sliderSteps), `${f.name} ${sl}`)
    const key = LOOK_FACE_SHAPE_SLIDERS.map((sl) => f.steps[sl]).join(',')
    assert.ok(!seen.has(key), `${f.name} is a face of its own`)
    seen.add(key)
    assert.equal(lookFaceShape(` ${f.name.toUpperCase()} `), f)
    for (const base of [...BODIES.map(zero), lookFromSeed(7), LOOK_PRESETS[3].look]) {
      const next = withFaceShape(base, f.name)!
      assert.deepEqual(next, { ...base, ...f.steps }, 'the eight sliders, nothing else')
      assert.equal(faceShapeNameOf(next), f)
    }
  }
  assert.equal(lookFaceShape('giant'), null)
  assert.equal(withFaceShape({ ...zero(0), body: 9 } as unknown as Look, 'oval'), null, 'never outside the wardrobe')
  assert.deepEqual(changeLook(zero(0), { kind: 'face', name: 'Heart' }, 0).look, withFaceShape(zero(0), 'heart'))
  assert.match(changeLook(zero(0), { kind: 'face', name: 'egg' }, 0).error ?? '', /no face shape named 'egg': oval, soft oval/)
})

// --- Builds ----------------------------------------------------------------------------------------------------

test('the builds: eight named frames over the mass, muscle, shoulders and hips sliders, slight to full; a build sets those four alone; buildOf names a look\'s build until a slider moves off it', () => {
  assert.deepEqual(LOOK_BUILDS.map((b) => b.name), ['slight', 'lean', 'athletic', 'muscular', 'broad', 'stocky', 'soft', 'full'])
  assert.deepEqual([...LOOK_BUILD_SLIDERS], ['mass', 'muscle', 'shoulders', 'hips'])
  assert.ok(Object.isFrozen(LOOK_BUILDS))
  const seen = new Set<string>()
  for (const b of LOOK_BUILDS) {
    assert.ok(Object.isFrozen(b) && Object.isFrozen(b.steps))
    assert.match(b.name, /^[a-z]+$/)
    assert.deepEqual(Object.keys(b.steps), [...LOOK_BUILD_SLIDERS])
    for (const s of LOOK_BUILD_SLIDERS) assert.ok(Number.isInteger(b.steps[s]) && b.steps[s] >= 0 && b.steps[s] < WARDROBE.sliderSteps, `${b.name} ${s}`)
    const key = LOOK_BUILD_SLIDERS.map((s) => b.steps[s]).join(',')
    assert.ok(!seen.has(key), `${b.name} is a frame of its own`)
    seen.add(key)
    assert.equal(lookBuild(` ${b.name.toUpperCase()} `), b)
    for (const base of [...BODIES.map(zero), lookFromSeed(7), LOOK_PRESETS[3].look]) {
      const next = withBuild(base, b.name)!
      assert.deepEqual(next, { ...base, ...b.steps }, 'the four sliders, nothing else (the height is never a build\'s)')
      assert.equal(buildOf(next), b)
      assert.equal(buildOf(withSlot(next, 'mass', (next.mass + 1) % 16)), LOOK_BUILDS.find((x) => LOOK_BUILD_SLIDERS.every((s) => x.steps[s] === (s === 'mass' ? (next.mass + 1) % 16 : next[s]))) ?? null)
    }
  }
  // The span: the masses climb from the slight to the full frame; the muscular frame has the most muscle, the broad the widest shoulders.
  const steps = (name: string) => lookBuild(name)!.steps
  assert.ok(steps('slight').mass < steps('lean').mass && steps('lean').mass < steps('athletic').mass && steps('stocky').mass < steps('full').mass)
  assert.equal(Math.max(...LOOK_BUILDS.map((b) => b.steps.muscle)), steps('muscular').muscle)
  assert.equal(Math.max(...LOOK_BUILDS.map((b) => b.steps.shoulders)), steps('broad').shoulders)
  assert.equal(lookBuild('giant'), null)
  assert.equal(withBuild(zero(0), 'giant'), null)
  assert.equal(withBuild({ ...zero(0), body: 9 } as unknown as Look, 'lean'), null, 'never outside the wardrobe')
  assert.equal(buildOf(zero(0)), null, 'every slider at its first step is no build')
})

// --- The look code ---------------------------------------------------------------------------------------------

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const crc8 = (ws: readonly number[]): number => {
  let crc = 0
  for (const word of ws) for (let i = 3; i >= 0; i--) {
    crc ^= (word >>> (i * 8)) & 0xff
    for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
  }
  return crc
}
const symbolsOf = (bits: bigint, n: number): string => {
  let out = ''
  for (let i = 0; i < n; i++) { out = ALPHABET[Number(bits & 31n)] + out; bits >>= 5n }
  return out
}
const SYMBOL = '[0-9A-HJKMNP-TV-Z]'

test('a look code is twenty-eight symbols "XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX", and a tail of eight per word when the genome\'s later words are not zero, that read back the same look, whatever the case or spacing', () => {
  const looks: Look[] = [...LOOK_PRESETS.map((p) => p.look), ...BODIES.map(zero)]
  for (let s = 0; s < 500; s++) looks.push(lookFromSeed(s))
  looks.push(withSlot(withSlot(zero(2), 'vitiligo', VITILIGO.handsAndFace), 'freckles', 2), withSlot(zero(1), 'skin', monkSkin(9)))
  const codes = new Set<string>()
  let tailed = 0
  for (const look of looks) {
    const code = formatLookCode(look)
    const later = packGenome(look).slice(4).some((w) => w !== 0)
    // The genome's words past 4 up to the last that is not zero (the skin word, the cloth word, the accessory word, the
    // tattoo words) ride the tail: eight symbols for one word, fifteen (eight and seven) for two, twenty-one (eight, eight
    // and five) for three, twenty-eight (eight, eight, eight and four) for four, thirty-four (eight four times and two) for five.
    const k = packGenome(look).slice(4).findLastIndex((w) => w !== 0) + 1
    const tail = k === 0 ? '' : k === 1 ? `-${SYMBOL}{8}` : k === 2 ? `-${SYMBOL}{8}-${SYMBOL}{7}` : k === 3 ? `-${SYMBOL}{8}-${SYMBOL}{8}-${SYMBOL}{5}` : k === 4 ? `-${SYMBOL}{8}-${SYMBOL}{8}-${SYMBOL}{8}-${SYMBOL}{4}` : `-${SYMBOL}{8}-${SYMBOL}{8}-${SYMBOL}{8}-${SYMBOL}{8}-${SYMBOL}{2}`
    assert.ok(k <= 5, 'words 9 to 15 are spare')
    assert.match(code, new RegExp(`^${SYMBOL}{7}-${SYMBOL}{7}-${SYMBOL}{7}-${SYMBOL}{7}${tail}$`), code)
    if (later) tailed++
    assert.deepEqual(parseLookCode(code), look)
    assert.deepEqual(parseLookCode(code.toLowerCase()), look)
    assert.deepEqual(parseLookCode(` ${code.replaceAll('-', '')} `), look)
    assert.deepEqual(parseLookCode(code.replaceAll('-', ' ')), look)
    codes.add(code)
  }
  assert.ok(tailed >= 500, 'every hashed look wears a Monk tone, so its code has a tail')
  assert.equal(codes.size, new Set(looks.map((l) => packGenome(l).join(':'))).size, 'distinct looks give distinct codes')
  assert.equal(formatLookCode(withSlot(zero(0), 'shoes', 3)), '', 'nothing outside the wardrobe has a code')
  assert.equal(formatLookCode(LOOK_PRESETS[0].look), '0B00144-S63RGY0-3RGY4R0-0000036', 'a look of the four words keeps the code it always had')
  assert.equal(formatLookCode(lookFromSeed(0)), '0P20HH8-S2409F8-9EXNA40-000027V-00M0W0E3')
  // A tail is checked on its own and binds the head: one symbol changed anywhere, the head alone, a zero last word, a
  // nonzero lead bit or a length no tail has is refused.
  const code = formatLookCode(lookFromSeed(0)).replaceAll('-', '')
  for (let i = 0; i < code.length; i++) for (const ch of ALPHABET) if (ch !== code[i]) assert.equal(parseLookCode(code.slice(0, i) + ch + code.slice(i + 1)), null, `${i} -> ${ch}`)
  assert.equal(parseLookCode(code.slice(0, 28)), null, 'the head cut off alone is not read as an older tone')
  for (let cut = 29; cut < code.length; cut++) assert.equal(parseLookCode(code.slice(0, cut)), null, `cut at ${cut}`)
  const genome = packGenome(lookFromSeed(0))
  const headOf = (ws: number[], check: number) => symbolsOf((BigInt(ws[0]) << 104n) | (BigInt(ws[1]) << 72n) | (BigInt(ws[2]) << 40n) | (BigInt(ws[3]) << 8n) | BigInt(check), 28)
  const twoWords = [...genome.slice(0, 5), 0]
  const padded = symbolsOf((BigInt(twoWords[4]) << 40n) | BigInt(crc8(twoWords.slice(4))), 15)
  assert.equal(parseLookCode(headOf(twoWords, crc8(twoWords)) + padded), null, 'a zero last word: one look, one code')
  const tailOf = (lead: bigint) => symbolsOf(lead | (BigInt(genome[4]) << 8n) | BigInt(crc8(genome.slice(4, 5))), 8)
  assert.deepEqual(parseLookCode(headOf(genome, crc8(genome.slice(0, 5))) + tailOf(0n)), lookFromSeed(0))
  assert.equal(code.length - 28, 8, 'one word and its check are forty bits: eight symbols, no lead bits')
  const forged = [...genome.slice(0, 4), (genome[4] | (1 << 31)) >>> 0]
  assert.equal(parseLookCode(headOf(forged, crc8(forged)) + symbolsOf((BigInt(forged[4]) << 8n) | BigInt(crc8(forged.slice(4))), 8)), null, 'a bit of the skin word no field holds')
})

test('a twenty-one-symbol code from before the layers, a fifteen-symbol one from before the face, and a legacy eight-symbol one, still read, upgraded; the same old code gives the same new look everywhere', () => {
  // Before the layers: three words, one zero lead bit, the check over the three; the wardrobe word it never had is zero.
  const navyV3 = LOOK_PRESETS[0].look
  const [w3, f3, c3] = words(navyV3)
  const v3 = symbolsOf((BigInt(w3) << 72n) | (BigInt(f3) << 40n) | (BigInt(c3) << 8n) | BigInt(crc8([w3, f3, c3])), 21)
  const codeV3 = `${v3.slice(0, 7)}-${v3.slice(7, 14)}-${v3.slice(14)}`
  assert.equal(codeV3, '2R00916-9GY47G0-Y47H65X', 'the code the preset had before the layers')
  assert.deepEqual(parseLookCode(codeV3), navyV3)
  assert.deepEqual(parseLookCode(codeV3.toLowerCase()), navyV3)
  assert.deepEqual(parseLookCode(formatLookCode(parseLookCode(codeV3)!)), navyV3, 'worn and written down again, it is a twenty-eight-symbol code that reads the same')
  assert.notEqual(formatLookCode(navyV3), codeV3)
  for (let i = 0; i < 21; i++) for (const ch of ALPHABET) if (ch !== v3[i]) assert.equal(parseLookCode(v3.slice(0, i) + ch + v3.slice(i + 1)), null)
  const goodV3 = (BigInt(w3) << 72n) | (BigInt(f3) << 40n) | (BigInt(c3) << 8n) | BigInt(crc8([w3, f3, c3]))
  assert.equal(parseLookCode(symbolsOf(goodV3 | (1n << 104n), 21)), null, 'the lead bit must be zero')
  const badV3 = w3 | (3 << LOOK_FIELD.shoes[1])
  assert.equal(parseLookCode(symbolsOf((BigInt(badV3) << 72n) | (BigInt(f3) << 40n) | (BigInt(c3) << 8n) | BigInt(crc8([badV3, f3, c3])), 21)), null, 'a checksum that is right over words that are no look')
  // Before the face: two words, the hair style at bit 6 of the look word, three zero lead bits.
  const navyV2 = v2Of(LOOK_PRESETS[0].look)
  const up = { ...LOOK_PRESETS[0].look, ...BASE_FACE }
  const wordV2 = oldWordOf(navyV2, LOOK_V2_SLOTS)
  const figure = packFigure(up)
  const v2 = symbolsOf((BigInt(wordV2) << 40n) | (BigInt(figure) << 8n) | BigInt(crc8([wordV2, figure])), 15)
  const codeV2 = `${v2.slice(0, 5)}-${v2.slice(5, 10)}-${v2.slice(10)}`
  assert.deepEqual(parseLookCode(codeV2), up)
  assert.deepEqual(parseLookCode(codeV2.toLowerCase()), up)
  assert.deepEqual(parseLookCode(formatLookCode(parseLookCode(codeV2)!)), up, 'worn and written down again, it is a twenty-eight-symbol code that reads the same')
  const longV2 = (wordV2 | (1 << LONG_HAIR_BIT)) >>> 0
  assert.deepEqual(parseLookCode(symbolsOf((BigInt(longV2) << 40n) | (BigInt(figure) << 8n) | BigInt(crc8([longV2, figure])), 15)), { ...up, hairStyle: 1 })
  for (let i = 0; i < 15; i++) for (const ch of ALPHABET) if (ch !== v2[i]) assert.equal(parseLookCode(v2.slice(0, i) + ch + v2.slice(i + 1)), null)
  const goodV2 = (BigInt(wordV2) << 40n) | (BigInt(figure) << 8n) | BigInt(crc8([wordV2, figure]))
  assert.equal(parseLookCode(symbolsOf(goodV2 | (1n << 72n), 15)), null, 'the three lead bits must be zero')
  assert.equal(parseLookCode(symbolsOf(goodV2 | (4n << 72n), 15)), null)
  const badV2 = wordV2 | (3 << LOOK_FIELD.shoes[1])
  assert.equal(parseLookCode(symbolsOf((BigInt(badV2) << 40n) | (BigInt(figure) << 8n) | BigInt(crc8([badV2, figure])), 15)), null, 'a checksum that is right over words that are no look')
  // Before the figure: one word, the height and build in its top bits.
  const navy = legacyOf(LOOK_PRESETS[0].look, 4, 3)
  const word = oldWordOf(navy, LEGACY_LOOK_SLOTS)
  const old = symbolsOf((BigInt(word) << 8n) | BigInt(crc8([word])), 8)
  const code = `${old.slice(0, 4)}-${old.slice(4)}`
  assert.deepEqual(parseLookCode(code), upgradeLegacyLook(navy))
  assert.deepEqual(parseLookCode(code.toLowerCase()), upgradeLegacyLook(navy))
  assert.equal(parseLookCode(code)!.height, 16)
  assert.equal(parseLookCode(code)!.mass, 6)
  assert.equal(parseLookCode(code)!.brow, 8)
  assert.deepEqual(parseLookCode(formatLookCode(parseLookCode(code)!)), parseLookCode(code))
  for (let i = 0; i < 8; i++) for (const ch of ALPHABET) if (ch !== old[i]) assert.equal(parseLookCode(old.slice(0, i) + ch + old.slice(i + 1)), null)
  const legacyBad = (word | (3 << LOOK_FIELD.shoes[1])) >>> 0
  assert.equal(parseLookCode(symbolsOf((BigInt(legacyBad) << 8n) | BigInt(crc8([legacyBad])), 8)), null)
})

test('parseLookCode refuses corruption: any one symbol changed, junk, the wrong length, a nonzero lead bit, and a code for an invalid word', () => {
  let tried = 0
  for (const p of LOOK_PRESETS) {
    const code = formatLookCode(p.look).replaceAll('-', '')
    for (let i = 0; i < code.length; i++) {
      for (const ch of ALPHABET) {
        if (ch === code[i]) continue
        assert.equal(parseLookCode(code.slice(0, i) + ch + code.slice(i + 1)), null, `${code} with ${i} -> ${ch}`)
        tried++
      }
    }
    // Two symbols swapped.
    const swapped = code.slice(0, 2) + code[3] + code[2] + code.slice(4)
    if (swapped !== code) assert.equal(parseLookCode(swapped), null)
  }
  assert.equal(tried, LOOK_PRESETS.length * 28 * 31)
  for (const junk of ['', ' ', 'hello', 'ABCD-EFG', 'ABCD-EFGHI', 'ABCDE-FGHJK-MNPQ', 'ABCDE-FGHJK-MNPQRS', 'ABCDEFG-HJKMNPQ-RSTVWX', 'ABCDEFG-HJKMNPQ-RSTVWXYZ', 'ABCI-0000', 'ABCL-0000', 'ABCO-0000', 'ABCU-0000', 'ABCD_EFGH', '!!!!-!!!!', '12345678x', '2R00916-9GY47G0-Y47H65I', '00002-89JC7-H1W5I', 'ABCDEFG-HJKMNPQ-RSTVWXY-Z012345', '0B00144-S63RGY0-3RGY4R0-000003I', '0B00144-S63RGY0-3RGY4R0-00000360'])
    assert.equal(parseLookCode(junk), null, junk)
  assert.equal(parseLookCode(undefined as unknown as string), null)
  assert.equal(parseLookCode(12345678 as unknown as string), null)
  // A code whose checksum is right but whose words are not a look (the suit with shoes 3; a forged long-hair bit) is still refused.
  const [word, figure, face, wardrobe] = words(zero(0))
  const pack = (w: number, f: number, c: number, r: number) => symbolsOf((BigInt(w) << 104n) | (BigInt(f) << 72n) | (BigInt(c) << 40n) | (BigInt(r) << 8n) | BigInt(crc8([w, f, c, r])), 28)
  assert.equal(parseLookCode(pack(word | (3 << LOOK_FIELD.shoes[1]), figure, face, wardrobe)), null)
  assert.equal(parseLookCode(pack(word | (1 << LONG_HAIR_BIT), figure, face, wardrobe)), null)
  assert.equal(parseLookCode(pack(word, figure, face, 3)), null, 'a fourth layer')
  assert.deepEqual(parseLookCode(pack(word, figure, face, wardrobe)), zero(0))
  assert.deepEqual(parseLookCode(pack(word, figure, face, 2 | (7 << LOOK_FIELD.scarf[1]))), { ...zero(0), layer: 2, scarf: 7 })
  // The lead bits must be zero even when the checksum (which they are outside) is right.
  const good = (BigInt(word) << 104n) | (BigInt(figure) << 72n) | (BigInt(face) << 40n) | (BigInt(wardrobe) << 8n) | BigInt(crc8([word, figure, face, wardrobe]))
  assert.deepEqual(parseLookCode(symbolsOf(good, 28)), zero(0))
  assert.equal(parseLookCode(symbolsOf(good | (1n << 136n), 28)), null)
  assert.equal(parseLookCode(symbolsOf(good | (8n << 136n), 28)), null)
})

// --- The console's view ----------------------------------------------------------------------------------------

test('describeLook: one ASCII line per slot and the code, with the height in metres, swatches, matching trousers, the piece names, the hair style and the undertone', () => {
  const lines = describeLook(LOOK_PRESETS[0].look)
  assert.equal(lines.length, LOOK_SLOTS.length + 1)
  for (const [i, slot] of LOOK_SLOTS.entries()) assert.ok(lines[i].startsWith(slot), lines[i])
  for (const line of lines) {
    assert.match(line, /^[\x20-\x7e]+$/)
    assert.doesNotMatch(line, /attack|kill|weapon|target|shoot|gun|violence|injur|damage/i)
  }
  const at = (slot: LookSlot) => lines[LOOK_SLOTS.indexOf(slot)]
  assert.equal(at('body'), 'body             suit  [1/4]')
  assert.equal(at('height'), 'height           1.78 m  [17/32]')
  assert.equal(at('mass'), 'mass             8  [8/16]')
  assert.equal(at('head'), 'head             5  [5/8]')
  assert.equal(at('brow'), 'brow             9  [9/16]')
  assert.equal(at('jaw'), 'jaw              10  [10/16]')
  assert.equal(at('age'), 'age              4  [4/8]')
  assert.equal(at('undertone'), 'undertone        warm  [2/4]')
  assert.equal(at('hairStyle'), 'hairStyle        short  [1/32]')
  assert.equal(at('top'), 'top              #1f2a44  [1/7]')
  assert.equal(at('layer'), 'layer            jacket  [1/3]')
  assert.equal(at('trim'), 'trim             matching (#1f2a44)  [1/8]')
  assert.equal(at('scarf'), 'scarf            none  [1/8]')
  assert.equal(at('bottom'), 'bottom           matching (#1f2a44)  [1/8]')
  assert.equal(at('tie'), 'tie              tie  [2/2]')
  assert.equal(at('eyewear'), 'eyewear          none  [1/2]')
  assert.equal(at('prostheticFinish'), 'prostheticFinish matte  [1/4]', 'the longest slot name keeps a space before its value')
  assert.equal(lines[LOOK_SLOTS.length], `code             ${formatLookCode(LOOK_PRESETS[0].look)}`)
  const grey = describeLook(withSlot(withSlot(zero(2), 'hairColour', 8), 'hairStyle', 3))
  assert.equal(grey[LOOK_SLOTS.indexOf('hairColour')], 'hairColour       grey  [9/9]')
  assert.equal(grey[LOOK_SLOTS.indexOf('hairStyle')], 'hairStyle        bun  [4/32]')
  assert.equal(grey[LOOK_SLOTS.indexOf('bottom')], 'bottom           matching (#1f2a44)  [1/4]')
  // Under a coat the top is the coat's cloth, the trousers still match the jacket, the trim the coat.
  const coated = describeLook(LOOK_PRESETS[1].look)
  assert.equal(LOOK_PRESETS[1].name, 'charcoal suit')
  assert.equal(coated[LOOK_SLOTS.indexOf('layer')], 'layer            coat  [3/3]')
  assert.equal(coated[LOOK_SLOTS.indexOf('top')], 'top              #1f2a44  [2/7]')
  assert.equal(coated[LOOK_SLOTS.indexOf('trim')], 'trim             matching (#1f2a44)  [1/8]')
  assert.equal(coated[LOOK_SLOTS.indexOf('bottom')], 'bottom           matching (#33363b)  [1/8]')
  assert.equal(coated[LOOK_SLOTS.indexOf('scarf')], 'scarf            #1c2c4c  [3/8]')
  assert.deepEqual(describeLook(withSlot(zero(0), 'shoes', 3)), ['look: outside the wardrobe'])
})

test('changeLook: a slot by number or name (a height in metres too), a preset, a code, random and reset; every refusal names why; never outside the wardrobe', () => {
  const suit = LOOK_PRESETS[0].look
  const ok = (r: ReturnType<typeof changeLook>): Look => { assert.equal(r.error, null, r.error ?? ''); return r.look! }
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'top', value: '2' }, 0)).top, 1)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'HairStyle', value: 'long' }, 0)).hairStyle, 1)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'hairStyle', value: 'bun' }, 0)).hairStyle, 3)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'hairStyle', value: 'Bald' }, 0)).hairStyle, 4)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'undertone', value: 'olive' }, 0)).undertone, 3)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'layer', value: 'shirt sleeves' }, 0)).layer, 1)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'layer', value: 'Coat' }, 0)).layer, 2)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'trim', value: 'matching' }, 0)).trim, 0)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'trim', value: '4' }, 0)).trim, 3)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'scarf', value: 'none' }, 0)).scarf, 0)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'scarf', value: lookOptions(0, 'scarf')[5].name }, 0)).scarf, 5)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'tie', value: 'NONE' }, 0)).tie, 0)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'body', value: 'skirt suit' }, 0)).body, 3)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'skin', value: lookOptions(0, 'skin')[2].name }, 0)).skin, 2)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'height', value: '32' }, 0)).height, 31)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'height', value: '1.80' }, 0)).height, 17)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'height', value: '1.80 m' }, 0)).height, 17)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'height', value: '2.05 m' }, 0)).height, 31)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'mass', value: '16' }, 0)).mass, 15)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'posture', value: '1' }, 0)).posture, 0)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'nose', value: '16' }, 0)).nose, 15)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'age', value: '8' }, 0)).age, 7)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'skin', value: 'MST-10' }, 0)).skin, 17)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'skin', value: '9' }, 0)).skin, monkSkin(0))
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'vitiligo', value: 'hands and face' }, 0)).vitiligo, VITILIGO.handsAndFace)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'freckles', value: 'Dense' }, 0)).freckles, 3)
  const built = ok(changeLook(suit, { kind: 'build', name: ' Athletic ' }, 0))
  assert.deepEqual(built, { ...suit, ...lookBuild('athletic')!.steps })
  assert.equal(buildOf(built)!.name, 'athletic')
  assert.deepEqual(ok(changeLook(suit, { kind: 'preset', name: ' Camel Blazer ' }, 0)), lookPreset('camel blazer')!.look)
  assert.deepEqual(ok(changeLook(suit, { kind: 'code', code: formatLookCode(LOOK_PRESETS[5].look).toLowerCase() }, 0)), LOOK_PRESETS[5].look)
  assert.deepEqual(ok(changeLook(suit, { kind: 'random', seed: 77 }, 0)), lookFromSeed(77))
  assert.deepEqual(ok(changeLook(suit, { kind: 'reset' }, 1337)), lookFromSeed(1337))
  for (const [change, why] of [
    [{ kind: 'slot', slot: 'hat', value: '1' }, /no slot named 'hat': body, height, mass/],
    [{ kind: 'slot', slot: 'top', value: '0' }, /top has \d+ options \(1-\d+\)/],
    [{ kind: 'slot', slot: 'top', value: '99' }, /top has \d+ options/],
    [{ kind: 'slot', slot: 'height', value: '33' }, /height has 32 options \(1-32\)/],
    [{ kind: 'slot', slot: 'height', value: 'tall' }, /no height named 'tall': 1-32/],
    [{ kind: 'slot', slot: 'mass', value: 'heavy' }, /no mass named 'heavy': 1-16/],
    [{ kind: 'slot', slot: 'brow', value: 'heavy' }, /no brow named 'heavy': 1-16/],
    [{ kind: 'slot', slot: 'age', value: 'old' }, /no age named 'old': 1-8/],
    [{ kind: 'slot', slot: 'tie', value: 'bow' }, /no tie named 'bow': none, tie/],
    [{ kind: 'slot', slot: 'hairStyle', value: 'quiff' }, /no hairStyle named 'quiff': short, long, bob, bun, bald, buzz cut/],
    [{ kind: 'slot', slot: 'undertone', value: 'pink' }, /no undertone named 'pink': neutral, warm, cool, olive/],
    [{ kind: 'slot', slot: 'vitiligo', value: 'stripes' }, /no vitiligo named 'stripes': none, hands, face, hands and face, scattered, widespread, one side/],
    [{ kind: 'slot', slot: 'freckles', value: '5' }, /freckles has 4 options \(1-4\)/],
    [{ kind: 'slot', slot: 'skin', value: '19' }, /skin has 18 options \(1-18\)/],
    [{ kind: 'slot', slot: 'layer', value: 'vest' }, /no layer named 'vest': jacket, shirt sleeves, coat/],
    [{ kind: 'slot', slot: 'scarf', value: '9' }, /scarf has 8 options \(1-8\)/],
    [{ kind: 'preset', name: 'tuxedo' }, /no preset named 'tuxedo': navy suit, /],
    [{ kind: 'code', code: 'ZZZZ-ZZZZ' }, /not a look code: 'ZZZZ-ZZZZ' \(twenty-eight symbols, XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX, and a tail when the look has one\)/],
    [{ kind: 'build', name: 'giant' }, /no build named 'giant': slight, lean, athletic, muscular, broad, stocky, soft, full/],
    [{ kind: 'random', seed: Number.NaN }, /seed must be a number/],
  ] as const) {
    const r = changeLook(suit, change, 0)
    assert.equal(r.look, null)
    assert.match(r.error ?? '', why)
  }
  assert.match(changeLook(withSlot(zero(0), 'shoes', 3), { kind: 'reset' }, 0).error ?? '', /outside the wardrobe/)
  // Every result validates, and the input is never touched.
  const before = JSON.stringify(suit)
  for (const change of [
    { kind: 'slot', slot: 'top', value: '2' }, { kind: 'slot', slot: 'height', value: '1.60 m' }, { kind: 'preset', name: 'navy blazer' },
    { kind: 'code', code: formatLookCode(LOOK_PRESETS[3].look) }, { kind: 'random', seed: 5 }, { kind: 'reset' },
  ] as const) {
    const r = changeLook(suit, change, 9)
    assert.notEqual(r.look, null)
    assert.deepEqual(validateLook(r.look!), r.look)
  }
  assert.equal(JSON.stringify(suit), before)
})
