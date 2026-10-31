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
  bodyShapeOf, changeLook, describeLook, faceShapeOf, faceValue, formatLookCode, GREY_HAIR, HAIR, hairBits, heightScale, LEGACY_LOOK_FIELD,
  LEGACY_LOOK_SLOTS, LONG_HAIR_BIT, LOOK_BODIES, LOOK_BODY_SLIDERS, LOOK_FACE_SLIDERS, LOOK_FIELD, LOOK_HASH, LOOK_HASHED_COLOUR,
  LOOK_HASHED_FACE, LOOK_HASHED_HAIR_SPLIT, LOOK_HASHED_SLIDER, LOOK_NONE, LOOK_ODDS, LOOK_PALETTE, LOOK_PIECE_BIT, LOOK_PRESETS,
  LOOK_SLIDER_MIDDLE, LOOK_SLOTS, LOOK_STATURE, LOOK_V2_SLOTS, lookFromSeed, lookMask, lookOptions, lookPreset, lookSize, lookSwatch,
  packFace, packFigure, packLook, parseLookCode, shaderHash, sliderValue, statureOf, statureStep, unpackFigureLook, unpackLegacyLook,
  unpackLook, upgradeFigureLook, upgradeLegacyLook, validateLook, WARDROBE, withLookSlot,
  type Look, type LookBody, type LookSlot,
} from './look.ts'

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
/** A look's three words. */
const words = (look: Look): [number, number, number] => [packLook(look), packFigure(look), packFace(look)]
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
  assert.deepEqual(LOOK_PIECE_BIT, { tie: PIECE.TIE, bag: PIECE.BAG, cup: PIECE.CUP, longHair: PIECE.LONG_HAIR, glasses: PIECE.GLASSES, hairCap: PIECE.HAIR_CAP, bob: PIECE.BOB, bun: PIECE.BUN, face: PIECE.FACE })
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
  assert.ok(CROWD.includes('? float(64).add(notShort.mul(past(LOOK_ODDS.bob).oneMinus()).mul(16)).add(notShort.mul(past(LOOK_ODDS.bob)).mul(past(LOOK_ODDS.bun).oneMinus()).mul(128)).add(notShort.mul(past(LOOK_ODDS.bun)).mul(256))'), 'a woman\'s hair')
  assert.ok(CROWD.includes(': past(LOOK_ODDS.bald).oneMinus().mul(float(64).add(notShort.mul(16)))'), 'a man\'s')
  assert.deepEqual([LOOK_ODDS.longHair, LOOK_ODDS.bob, LOOK_ODDS.bun, LOOK_ODDS.bald], [0.35, 0.34, 0.67, 0.96])
  assert.equal(LOOK_HASHED_HAIR_SPLIT, 22)
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
  const links = [...Object.values(LOOK_HASHED_SLIDER), ...Object.values(LOOK_HASHED_FACE), LOOK_HASHED_HAIR_SPLIT]
  assert.equal(new Set(links).size, links.length, 'a link each')
  for (const k of links) assert.ok(k === 7 || k >= 9, `link ${k} is free of the pieces (1-5), the height (6) and the idle phase (8)`)
  // The hashed age, undertone and iris: the fragment chain's free links (1-6 and 9-12 are the colours).
  assert.deepEqual(LOOK_HASHED_COLOUR, { age: 7, undertone: 8, iris: 13 })
  assert.ok(CROWD.includes('h(LOOK_HASHED_COLOUR.age).mul(WARDROBE.ageSteps - 1).add(0.5).floor()).div(WARDROBE.ageSteps - 1)'))
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
    skin: 8, age: 8, undertone: 4, hairStyle: 5, hairColour: 9, tie: 2, eyewear: 2, bag: 2, cup: 2,
  }
  assert.deepEqual(sizes(0), { ...common, top: 7, bottom: 8, shirt: 6, shoes: 3 })
  assert.deepEqual(sizes(1), { ...common, top: 7, bottom: 6, shirt: 6, shoes: 4 })
  assert.deepEqual(sizes(2), { ...common, top: 7, bottom: 4, shirt: 6, shoes: 4 })
  assert.deepEqual(sizes(3), { ...common, top: 6, bottom: 6, shirt: 6, shoes: 4 })
  for (const b of BODIES) {
    assert.deepEqual(lookOptions(b, 'hairColour').map((o) => o.hex), [...LOOK_PALETTE.hair, GREY_HAIR])
    assert.deepEqual(lookOptions(b, 'skin').map((o) => o.hex), [...LOOK_PALETTE.skin])
    const o = WARDROBE.outfits[b]
    assert.deepEqual(lookOptions(b, 'top').map((x) => x.hex), [...LOOK_PALETTE[o.top]])
    assert.deepEqual(lookOptions(b, 'bottom').map((x) => x.hex), [...(o.matching ? [null] : []), ...LOOK_PALETTE[o.bottom]])
    assert.deepEqual(lookOptions(b, 'shirt').map((x) => x.hex), [...LOOK_PALETTE[o.shirt]])
    assert.deepEqual(lookOptions(b, 'shoes').map((x) => x.hex), [...LOOK_PALETTE[o.shoes]])
    for (const s of ['tie', 'eyewear', 'bag', 'cup', 'hairStyle', 'undertone'] as const) {
      assert.equal(lookOptions(b, s)[0].name, s === 'hairStyle' ? 'short' : s === 'undertone' ? 'neutral' : 'none')
      assert.ok(lookOptions(b, s).every((x) => x.hex === null))
    }
    assert.deepEqual(lookOptions(b, 'hairStyle').map((x) => x.name), ['short', 'long', 'bob', 'bun', 'bald'])
    assert.deepEqual(lookOptions(b, 'undertone').map((x) => x.name), ['neutral', 'warm', 'cool', 'olive'])
    for (const s of LOOK_SLOTS) for (const x of lookOptions(b, s)) assert.match(x.name, /^[\x20-\x7e]+$/, 'ASCII names')
    // The height reads in metres; the other sliders count their steps.
    assert.deepEqual([lookOptions(b, 'height')[0].name, lookOptions(b, 'height')[31].name], ['1.50 m', '2.05 m'])
    assert.deepEqual([lookOptions(b, 'mass')[0].name, lookOptions(b, 'mass')[15].name, lookOptions(b, 'head')[7].name, lookOptions(b, 'nose')[15].name, lookOptions(b, 'age')[7].name], ['1', '16', '8', '16', '8'])
  }
  assert.equal(LOOK_SLOTS.length, 29)
  assert.deepEqual(LOOK_SLOTS.slice(0, 9), ['body', ...LOOK_BODY_SLIDERS])
  assert.deepEqual(LOOK_SLOTS.slice(9, 16), [...LOOK_FACE_SLIDERS])
  assert.deepEqual([...LOOK_V2_SLOTS], LOOK_SLOTS.filter((s) => !(LOOK_FACE_SLIDERS as readonly string[]).includes(s) && s !== 'age' && s !== 'undertone'))
  assert.equal(LOOK_V2_SLOTS.length, 20)
  assert.equal(LEGACY_LOOK_SLOTS.length, 14)
  assert.deepEqual(HAIR, { short: 0, long: 1, bob: 2, bun: 3, bald: 4 })
  assert.deepEqual(WARDROBE.hairStyle.map((_, i) => i), Object.values(HAIR).sort((a, b) => a - b))
  assert.equal(WARDROBE.ageSteps, 8)
  assert.ok(Object.isFrozen(WARDROBE) && Object.isFrozen(WARDROBE.outfits) && Object.isFrozen(LOOK_FIELD) && Object.isFrozen(HAIR))
})

test('lookSwatch: colours for colour slots, the top\'s cloth for matching trousers, null for pieces and sliders', () => {
  const suit = zero(0)
  assert.equal(lookSwatch(suit, 'top'), LOOK_PALETTE.suits[0])
  assert.equal(lookSwatch(suit, 'bottom'), LOOK_PALETTE.suits[0], 'matching')
  assert.equal(lookSwatch(withSlot(suit, 'bottom', 3), 'bottom'), LOOK_PALETTE.suits[2])
  assert.equal(lookSwatch(withSlot(zero(2), 'bottom', 1), 'bottom'), LOOK_PALETTE.darkTrousers[0])
  assert.equal(lookSwatch(withSlot(suit, 'hairColour', 8), 'hairColour'), GREY_HAIR)
  assert.equal(lookSwatch(suit, 'tie'), null)
  assert.equal(lookSwatch(suit, 'height'), null)
  assert.equal(lookSwatch(suit, 'mass'), null)
  assert.equal(lookSwatch(suit, 'brow'), null)
  assert.equal(lookSwatch(suit, 'undertone'), null)
})

// --- The packed words ------------------------------------------------------------------------------------------

test('LOOK_FIELD: three words; the look word\'s bit 0 is the valid flag and bit 6 the long-hair bit, its fields tile the rest to bit 30; the figure word is full; the face word tiles bits 0 to 30; each field wide enough for its slot', () => {
  const used = [new Set([0, LONG_HAIR_BIT]), new Set<number>(), new Set<number>()]
  for (const slot of LOOK_SLOTS) {
    const [word, shift, width] = LOOK_FIELD[slot]
    const largest = Math.max(...BODIES.map((b) => lookSize(b, slot)))
    assert.ok(largest <= 1 << width, `${slot}: ${largest} options in ${width} bits`)
    assert.ok(shift + width <= 32)
    for (let b = shift; b < shift + width; b++) {
      assert.ok(!used[word].has(b), `${slot} overlaps bit ${b} of word ${word}`)
      used[word].add(b)
    }
    const expected = (LOOK_BODY_SLIDERS as readonly string[]).includes(slot) ? 1 : (LOOK_FACE_SLIDERS as readonly string[]).includes(slot) || slot === 'hairStyle' ? 2 : 0
    assert.equal(word, expected, `${slot} is in word ${expected}`)
  }
  assert.equal(used[0].size, 31)
  assert.ok(!used[0].has(31), 'the look word\'s top bit is spare')
  assert.equal(used[1].size, 32)
  assert.equal(used[2].size, 31)
  assert.ok(!used[2].has(31), 'the face word\'s top bit is spare')
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
  assert.deepEqual([LEGACY_LOOK_FIELD.height, LEGACY_LOOK_FIELD.build, LEGACY_LOOK_FIELD.steps], [[26, 3], [29, 3], 8])
})

test('packLook/packFigure/packFace/unpackLook round-trip every slot value of every body; a packed look word always has bit 0 set; each slot lives in one word', () => {
  let count = 0
  for (const b of BODIES) {
    for (const slot of LOOK_SLOTS) {
      if (slot === 'body') continue
      for (let v = 0; v < lookSize(b, slot); v++) {
        const look = withSlot(zero(b), slot, v)
        const [word, figure, face] = words(look)
        assert.equal(word & 1, 1)
        for (const w of [word, figure, face]) assert.ok(w >= 0 && w <= 0xffffffff && Number.isInteger(w))
        assert.deepEqual(unpackLook(word, figure, face), look, `${LOOK_BODIES[b]} ${slot}=${v}`)
        count++
      }
    }
    // Every slot at its last option at once.
    const full: Record<string, number> = {}
    for (const s of LOOK_SLOTS) full[s] = s === 'body' ? b : lookSize(b, s) - 1
    assert.deepEqual(unpackLook(...words(full as Look)), full)
  }
  assert.ok(count > 800)
  // The head's last step uses the figure word's top bits: the words are unsigned.
  const tall = withSlot(withSlot(zero(0), 'head', 7), 'height', 31)
  assert.ok(packFigure(tall) > 0x7fffffff)
  assert.deepEqual(unpackLook(...words(tall)), tall)
  // The spare top bits are zero; the body sliders live in the figure word alone, the face sliders in the face word alone.
  assert.equal(packLook(tall) >>> 31, 0)
  assert.equal(packFace(withSlot(zero(0), 'lips', 15)) >>> 31, 0)
  assert.equal(packLook(tall), packLook(zero(0)))
  assert.equal(packFace(tall), packFace(zero(0)))
  assert.equal(packFigure(withSlot(zero(0), 'shoes', 2)), packFigure(zero(0)))
  const nosed = withSlot(zero(0), 'nose', 3)
  assert.equal(packLook(nosed), packLook(zero(0)))
  assert.equal(packFigure(nosed), packFigure(zero(0)))
  assert.notEqual(packFace(nosed), packFace(zero(0)))
  // The long-hair bit of the look word follows the style: set for long hair alone.
  for (const style of [0, 1, 2, 3, 4]) assert.equal((packLook(withSlot(zero(2), 'hairStyle', style)) >>> LONG_HAIR_BIT) & 1, style === HAIR.long ? 1 : 0, `style ${style}`)
  assert.equal(packLook(withSlot(zero(2), 'hairStyle', 2)), packLook(zero(2)), 'a bob changes the face word alone')
})

test('unpackLook refuses LOOK_NONE, words outside u32, fields outside the body\'s options, and a long-hair bit that disagrees with the style', () => {
  assert.equal(unpackLook(LOOK_NONE, 0, 0), null)
  assert.equal(unpackLook(LOOK_NONE, packFigure(zero(0)), packFace(zero(0))), null)
  for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 32 + 1, 2]) assert.equal(unpackLook(bad, 0, 0), null)
  for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 32 + 1]) {
    assert.equal(unpackLook(packLook(zero(0)), bad, 0), null)
    assert.equal(unpackLook(packLook(zero(0)), 0, bad), null)
  }
  const [suit, figure, face] = words(zero(0))
  assert.equal(unpackLook(suit | (3 << LOOK_FIELD.shoes[1]), figure, face), null, 'the suit has three shoes')
  assert.equal(unpackLook(suit | (9 << LOOK_FIELD.hairColour[1]), figure, face), null, 'nine hair colours')
  assert.equal(unpackLook(suit | (7 << LOOK_FIELD.top[1]), figure, face), null, 'seven suit cloths')
  assert.equal(unpackLook(packLook(zero(2)) | (4 << LOOK_FIELD.bottom[1]), figure, face), null, 'matching plus three dark trousers')
  assert.equal(unpackLook(suit, figure, 5 << LOOK_FIELD.hairStyle[1]), null, 'five hair styles')
  assert.equal(unpackLook(suit, figure, 7 << LOOK_FIELD.hairStyle[1]), null)
  assert.equal(packLook(withSlot(zero(0), 'shoes', 3)), LOOK_NONE, 'nothing outside the wardrobe packs')
  assert.equal(packFigure(withSlot(zero(0), 'shoes', 3)), 0)
  assert.equal(packFace(withSlot(zero(0), 'shoes', 3)), 0)
  // Every value of the figure word is a figure: its fields are exactly as wide as their sliders. The face word's
  // sliders likewise; its style alone can overflow.
  for (const f of [0, 0xffffffff, 0x12345678, 0x80000001]) assert.notEqual(unpackLook(suit, f, face), null)
  assert.equal(unpackLook(suit, 0xffffffff, face)!.height, 31)
  assert.equal(unpackLook(suit, 0xffffffff, face)!.head, 7)
  assert.deepEqual(unpackLook(suit, figure, 0x0fffffff), { ...zero(0), brow: 15, jaw: 15, chin: 15, cheek: 15, nose: 15, eyes: 15, lips: 15 })
  // The look word's bit 6 must say what the face word's style says: a forged pair is no look.
  assert.equal(unpackLook(suit | (1 << LONG_HAIR_BIT), figure, face), null, 'long-hair bit, short style')
  assert.equal(unpackLook(suit, figure, face | (HAIR.long << LOOK_FIELD.hairStyle[1])), null, 'long style, no bit')
  assert.deepEqual(unpackLook(suit | (1 << LONG_HAIR_BIT), figure, face | (HAIR.long << LOOK_FIELD.hairStyle[1])), withSlot(zero(0), 'hairStyle', HAIR.long))
  assert.deepEqual(unpackLook(suit, figure, face | (HAIR.bun << LOOK_FIELD.hairStyle[1])), withSlot(zero(0), 'hairStyle', HAIR.bun))
})

test('lookMask: the pieces land where the crowd\'s vertex stage (crowdBody.ts) tests them (tie 2, bag 4, cup 8, long hair 16, glasses 32, the cap 64, a bob 128, a bun 256, the face 512)', () => {
  assert.equal(lookMask(LOOK_NONE, 0), 0)
  assert.equal(lookMask(LOOK_NONE, packFace(withSlot(zero(0), 'hairStyle', 1))), 0)
  const cap = 1 << LOOK_PIECE_BIT.hairCap, face = 1 << LOOK_PIECE_BIT.face
  assert.equal(lookMask(...pair(zero(0))), cap | face, 'short hair: the cap and the features')
  const pieces: [LookSlot, number][] = [['tie', 2], ['bag', 4], ['cup', 8], ['eyewear', 32]]
  let all = zero(1)
  for (const [slot, bit] of pieces) {
    assert.equal(lookMask(...pair(withSlot(zero(1), slot, 1))), bit | cap | face)
    all = withSlot(all, slot, 1)
  }
  const [word, faceWord] = pair(all)
  assert.equal(lookMask(word, faceWord), 46 | cap | face)
  assert.equal((word >>> 2) & 46, 46, 'the wiring stage\'s expression')
  for (const [, bit] of pieces) assert.equal((lookMask(word, faceWord) >> Math.log2(bit)) & 1, 1)
  // The hair's pieces follow the style (hairBits): long hair with the cap, a bob with the cap, a bun with the cap, bald nothing.
  assert.deepEqual([0, 1, 2, 3, 4].map(hairBits), [cap, 16 | cap, 128 | cap, 256 | cap, 0])
  for (const style of [0, 1, 2, 3, 4]) assert.equal(lookMask(...pair(withSlot(zero(2), 'hairStyle', style))), hairBits(style) | face, `style ${style}`)
  assert.equal(lookMask(...pair(withSlot(all, 'hairStyle', HAIR.long))), 62 | cap | face)
  function pair(look: Look): [number, number] { return [packLook(look), packFace(look)] }
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
  const up = { ...LOOK_PRESETS[0].look, height: 16, mass: 6, muscle: 8, shoulders: 8, hips: 8, legs: 8, posture: 8, head: 4, ...BASE_FACE }
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
  const up = { ...LOOK_PRESETS[0].look, ...BASE_FACE }
  assert.deepEqual(upgradeFigureLook(navy), up)
  assert.deepEqual(validateLook(navy), up, 'validateLook takes the v2 shape')
  assert.ok(Object.isFrozen(validateLook(navy)))
  for (const style of [0, 1]) assert.equal(upgradeFigureLook({ ...navy, hairStyle: style })!.hairStyle, style)
  for (const b of BODIES) assert.deepEqual(upgradeFigureLook(v2Of(zero(b))), { ...zero(b), ...BASE_FACE }, LOOK_BODIES[b])
  for (let s = 0; s < 200; s++) {
    const look = lookFromSeed(s)
    const old = v2Of(look)
    assert.deepEqual(upgradeFigureLook(old), { ...look, ...BASE_FACE, hairStyle: old.hairStyle })
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
  assert.equal(withLookSlot(suit, 'hairStyle', 5), null)
  assert.equal(withLookSlot(suit, 'nose', 15)!.nose, 15)
  assert.equal(withLookSlot(suit, 'nose', 16), null)
  assert.equal(withLookSlot(suit, 'undertone', 4), null)
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
    assert.deepEqual(unpackLook(...words(look)), look)
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
    assert.equal(look.skin, idx(hc(1), 8))
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
  }
  // Odd seeds still give a look: the city must always dress someone.
  for (const s of [NaN, -5, Infinity, 1.7, 2 ** 40, 0xffffffff]) assert.deepEqual(validateLook(lookFromSeed(s)), lookFromSeed(s))
  assert.deepEqual(lookFromSeed(-5), lookFromSeed(5))
  assert.deepEqual(lookFromSeed(1.7), lookFromSeed(1))
})

test('lookFromSeed is pinned for the player\'s slot and the first agents, and its odds match the crowd\'s', () => {
  assert.deepEqual(lookFromSeed(0), { body: 0, height: 26, mass: 11, muscle: 4, shoulders: 0, hips: 8, legs: 8, posture: 8, head: 4, brow: 4, jaw: 4, chin: 5, cheek: 13, nose: 14, eyes: 14, lips: 2, skin: 3, age: 6, undertone: 2, hairStyle: 1, hairColour: 1, top: 1, bottom: 0, shirt: 2, shoes: 0, tie: 0, eyewear: 0, bag: 1, cup: 0 })
  assert.deepEqual(lookFromSeed(1), { body: 1, height: 28, mass: 8, muscle: 14, shoulders: 4, hips: 15, legs: 12, posture: 5, head: 1, brow: 7, jaw: 11, chin: 15, cheek: 15, nose: 9, eyes: 4, lips: 4, skin: 0, age: 3, undertone: 2, hairStyle: 0, hairColour: 1, top: 4, bottom: 0, shirt: 3, shoes: 0, tie: 0, eyewear: 0, bag: 1, cup: 0 })
  assert.deepEqual(lookFromSeed(2), { body: 2, height: 11, mass: 15, muscle: 12, shoulders: 4, hips: 4, legs: 3, posture: 2, head: 7, brow: 15, jaw: 2, chin: 2, cheek: 11, nose: 12, eyes: 1, lips: 6, skin: 2, age: 4, undertone: 2, hairStyle: 1, hairColour: 6, top: 5, bottom: 3, shirt: 4, shoes: 3, tie: 0, eyewear: 0, bag: 0, cup: 0 })
  assert.deepEqual(lookFromSeed(3), { body: 3, height: 18, mass: 1, muscle: 4, shoulders: 10, hips: 2, legs: 1, posture: 10, head: 3, brow: 12, jaw: 9, chin: 8, cheek: 9, nose: 14, eyes: 7, lips: 6, skin: 3, age: 2, undertone: 0, hairStyle: 2, hairColour: 6, top: 4, bottom: 2, shirt: 1, shoes: 0, tie: 0, eyewear: 1, bag: 0, cup: 0 })
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
})

// --- Presets ---------------------------------------------------------------------------------------------------

test('every preset validates, names are unique ASCII words, every body is dressed, and lookPreset finds them', () => {
  assert.ok(LOOK_PRESETS.length >= 8)
  assert.ok(Object.isFrozen(LOOK_PRESETS))
  const names = new Set<string>()
  const bodies = new Set<number>()
  const styles = new Set<number>()
  for (const p of LOOK_PRESETS) {
    assert.match(p.name, /^[a-z][a-z ]*[a-z]$/)
    assert.ok(!names.has(p.name), p.name)
    names.add(p.name)
    assert.deepEqual(validateLook(p.look), p.look)
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.look))
    bodies.add(p.look.body)
    styles.add(p.look.hairStyle)
    assert.deepEqual(unpackLook(...words(p.look)), p.look)
    assert.deepEqual(lookPreset(p.name), p)
    assert.deepEqual(lookPreset(` ${p.name.toUpperCase()} `), p)
    assert.ok(statureOf(p.look.height) >= 1.6 && statureOf(p.look.height) <= 1.9, `${p.name} stands ${statureOf(p.look.height)} m`)
    for (const f of LOOK_FACE_SLIDERS) assert.ok(p.look[f] >= 5 && p.look[f] <= 11, `${p.name}'s ${f} is a face, not a caricature`)
  }
  assert.equal(bodies.size, 4)
  assert.equal(styles.size, 5, 'every hair style is shown by a preset')
  assert.equal(lookPreset('tuxedo'), null)
  assert.equal(lookPreset(''), null)
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

test('a look code is twenty-one symbols "XXXXXXX-XXXXXXX-XXXXXXX" that read back the same look, whatever the case or spacing', () => {
  const looks: Look[] = [...LOOK_PRESETS.map((p) => p.look), ...BODIES.map(zero)]
  for (let s = 0; s < 500; s++) looks.push(lookFromSeed(s))
  const codes = new Set<string>()
  for (const look of looks) {
    const code = formatLookCode(look)
    assert.match(code, new RegExp(`^${SYMBOL}{7}-${SYMBOL}{7}-${SYMBOL}{7}$`), code)
    assert.deepEqual(parseLookCode(code), look)
    assert.deepEqual(parseLookCode(code.toLowerCase()), look)
    assert.deepEqual(parseLookCode(` ${code.replaceAll('-', '')} `), look)
    assert.deepEqual(parseLookCode(code.replaceAll('-', ' ')), look)
    codes.add(code)
  }
  assert.equal(codes.size, new Set(looks.map((l) => words(l).join(':'))).size, 'distinct looks give distinct codes')
  assert.equal(formatLookCode(withSlot(zero(0), 'shoes', 3)), '', 'nothing outside the wardrobe has a code')
  assert.equal(formatLookCode(LOOK_PRESETS[0].look), '2R00916-9GY47G0-Y47H65X')
})

test('a fifteen-symbol code from before the face, and a legacy eight-symbol one, still read, upgraded; the same old code gives the same new look everywhere', () => {
  // Before the face: two words, the hair style at bit 6 of the look word, three zero lead bits.
  const navyV2 = v2Of(LOOK_PRESETS[0].look)
  const up = { ...LOOK_PRESETS[0].look, ...BASE_FACE }
  const wordV2 = oldWordOf(navyV2, LOOK_V2_SLOTS)
  const figure = packFigure(up)
  const v2 = symbolsOf((BigInt(wordV2) << 40n) | (BigInt(figure) << 8n) | BigInt(crc8([wordV2, figure])), 15)
  const codeV2 = `${v2.slice(0, 5)}-${v2.slice(5, 10)}-${v2.slice(10)}`
  assert.deepEqual(parseLookCode(codeV2), up)
  assert.deepEqual(parseLookCode(codeV2.toLowerCase()), up)
  assert.deepEqual(parseLookCode(formatLookCode(parseLookCode(codeV2)!)), up, 'worn and written down again, it is a twenty-one-symbol code that reads the same')
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
  assert.equal(tried, LOOK_PRESETS.length * 21 * 31)
  for (const junk of ['', ' ', 'hello', 'ABCD-EFG', 'ABCD-EFGHI', 'ABCDE-FGHJK-MNPQ', 'ABCDE-FGHJK-MNPQRS', 'ABCDEFG-HJKMNPQ-RSTVWX', 'ABCDEFG-HJKMNPQ-RSTVWXYZ', 'ABCI-0000', 'ABCL-0000', 'ABCO-0000', 'ABCU-0000', 'ABCD_EFGH', '!!!!-!!!!', '12345678x', '2R00916-9GY47G0-Y47H65I', '00002-89JC7-H1W5I'])
    assert.equal(parseLookCode(junk), null, junk)
  assert.equal(parseLookCode(undefined as unknown as string), null)
  assert.equal(parseLookCode(12345678 as unknown as string), null)
  // A code whose checksum is right but whose words are not a look (the suit with shoes 3; a forged long-hair bit) is still refused.
  const [word, figure, face] = words(zero(0))
  const pack = (w: number, f: number, c: number) => symbolsOf((BigInt(w) << 72n) | (BigInt(f) << 40n) | (BigInt(c) << 8n) | BigInt(crc8([w, f, c])), 21)
  assert.equal(parseLookCode(pack(word | (3 << LOOK_FIELD.shoes[1]), figure, face)), null)
  assert.equal(parseLookCode(pack(word | (1 << LONG_HAIR_BIT), figure, face)), null)
  assert.equal(parseLookCode(pack(word, figure, 5 << LOOK_FIELD.hairStyle[1])), null)
  assert.deepEqual(parseLookCode(pack(word, figure, face)), zero(0))
  // The lead bit must be zero even when the checksum (which it is outside) is right.
  const good = (BigInt(word) << 72n) | (BigInt(figure) << 40n) | (BigInt(face) << 8n) | BigInt(crc8([word, figure, face]))
  assert.deepEqual(parseLookCode(symbolsOf(good, 21)), zero(0))
  assert.equal(parseLookCode(symbolsOf(good | (1n << 104n), 21)), null)
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
  assert.equal(at('body'), 'body       suit  [1/4]')
  assert.equal(at('height'), 'height     1.78 m  [17/32]')
  assert.equal(at('mass'), 'mass       8  [8/16]')
  assert.equal(at('head'), 'head       5  [5/8]')
  assert.equal(at('brow'), 'brow       9  [9/16]')
  assert.equal(at('jaw'), 'jaw        10  [10/16]')
  assert.equal(at('age'), 'age        4  [4/8]')
  assert.equal(at('undertone'), 'undertone  warm  [2/4]')
  assert.equal(at('hairStyle'), 'hairStyle  short  [1/5]')
  assert.equal(at('top'), 'top        #1f2a44  [1/7]')
  assert.equal(at('bottom'), 'bottom     matching (#1f2a44)  [1/8]')
  assert.equal(at('tie'), 'tie        tie  [2/2]')
  assert.equal(at('eyewear'), 'eyewear    none  [1/2]')
  assert.equal(lines[LOOK_SLOTS.length], `code       ${formatLookCode(LOOK_PRESETS[0].look)}`)
  const grey = describeLook(withSlot(withSlot(zero(2), 'hairColour', 8), 'hairStyle', 3))
  assert.equal(grey[LOOK_SLOTS.indexOf('hairColour')], 'hairColour grey  [9/9]')
  assert.equal(grey[LOOK_SLOTS.indexOf('hairStyle')], 'hairStyle  bun  [4/5]')
  assert.equal(grey[LOOK_SLOTS.indexOf('bottom')], 'bottom     matching (#1f2a44)  [1/4]')
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
    [{ kind: 'slot', slot: 'hairStyle', value: 'mohawk' }, /no hairStyle named 'mohawk': short, long, bob, bun, bald/],
    [{ kind: 'slot', slot: 'undertone', value: 'pink' }, /no undertone named 'pink': neutral, warm, cool, olive/],
    [{ kind: 'preset', name: 'tuxedo' }, /no preset named 'tuxedo': navy suit, /],
    [{ kind: 'code', code: 'ZZZZ-ZZZZ' }, /not a look code: 'ZZZZ-ZZZZ' \(twenty-one symbols, XXXXXXX-XXXXXXX-XXXXXXX\)/],
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
