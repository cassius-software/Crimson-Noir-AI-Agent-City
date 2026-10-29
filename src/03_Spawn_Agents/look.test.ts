// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The wardrobe is only closed if nothing drifts: the catalogue must be exactly the crowd's
 * palettes and pieces (crowd.ts cannot load in Node, it imports a WGSL file, so its source text is read instead),
 * the two packed words must carry every slot back out unchanged with the pieces at the crowd's own bit positions and
 * the sliders in the figure word the shader reads, the validator must refuse everything that is not an index into
 * the catalogue (and upgrade a look kept before the figure existed, never drop it), a look code must survive copying
 * and refuse corruption, every preset must be wearable, and the seed path must reproduce three's hash bit for bit,
 * the sliders' rounding included.
 * What breaks if it is removed? A palette could grow a colour the crowd never wears, a bit could move and dress
 * agent 0 in the wrong cloth, or a returning visitor's saved look could be forgotten.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BODY_NAMES, HEIGHT_BASE, PIECE, SHAPE_NEUTRAL } from './humanoid.ts'
import {
  bodyShapeOf, changeLook, describeLook, formatLookCode, GREY_HAIR, heightScale, LEGACY_LOOK_FIELD, LEGACY_LOOK_SLOTS, LOOK_BODIES,
  LOOK_BODY_SLIDERS, LOOK_FIELD, LOOK_HASH, LOOK_HASHED_SLIDER, LOOK_NONE, LOOK_ODDS, LOOK_PALETTE, LOOK_PIECE_BIT, LOOK_PRESETS,
  LOOK_SLIDER_MIDDLE, LOOK_SLOTS, LOOK_STATURE, lookFromSeed, lookMask, lookOptions, lookPreset, lookSize, lookSwatch, packFigure,
  packLook, parseLookCode, shaderHash, sliderValue, statureOf, statureStep, unpackLegacyLook, unpackLook, upgradeLegacyLook,
  validateLook, WARDROBE, withLookSlot,
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
/** A look's two words. */
const words = (look: Look): [number, number] => [packLook(look), packFigure(look)]
/** A look as it was kept before the figure: the fourteen legacy slots, with the height and build given. */
const legacyOf = (look: Look, height: number, build: number): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const s of LEGACY_LOOK_SLOTS) out[s] = s === 'height' ? height : s === 'build' ? build : look[s as LookSlot]
  return out
}

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

test('the bodies, the piece bits, the grey, the hash chains, the odds and the hashed figure are the crowd\'s', () => {
  assert.ok(CROWD.includes('export const VARIANT_NAMES = BODY_NAMES'), 'one list of body names')
  assert.deepEqual([...LOOK_BODIES], [...BODY_NAMES])
  assert.deepEqual(WARDROBE.bodies, LOOK_BODIES)
  assert.deepEqual(LOOK_PIECE_BIT, { tie: PIECE.TIE, bag: PIECE.BAG, cup: PIECE.CUP, longHair: PIECE.LONG_HAIR, glasses: PIECE.GLASSES })
  assert.equal(PIECE.NONE, 0)
  assert.ok(CROWD.includes('vec3(0.6, 0.6, 0.58), step(0.9, h(9))'), 'grey hair mix')
  assert.equal(GREY_HAIR, (Math.round(0.6 * 255) << 16) | (Math.round(0.6 * 255) << 8) | Math.round(0.58 * 255))
  assert.ok(CROWD.includes(`hash(seed.add(k * ${LOOK_HASH.pieces}))`), 'vertex chain')
  assert.ok(CROWD.includes(`hash(vSeed.add(k * ${LOOK_HASH.colours}))`), 'fragment chain')
  assert.ok(CROWD.includes(`step(${LOOK_ODDS.tie}, h(1)).mul(2)`))
  assert.ok(CROWD.includes(`step(woman ? ${LOOK_ODDS.bagWoman} : ${LOOK_ODDS.bagMan}, h(2)).mul(4)`))
  assert.ok(CROWD.includes(`step(${LOOK_ODDS.cup}, h(3)).mul(8)`))
  assert.ok(CROWD.includes(`step(${LOOK_ODDS.longHair}, h(4)).mul(16)`))
  assert.ok(CROWD.includes(`step(${LOOK_ODDS.glasses}, h(5)).mul(32)`))
  assert.ok(CROWD.includes(`step(${LOOK_ODDS.darkTrousers}, h(10))`))
  assert.ok(CROWD.includes('uint(hk.mul(list.length - 0.001))'), 'pick truncates hk * (len - 0.001)')
  // The hashed figure: the same links of the chain, rounded to the same steps, the stature from this body's range.
  assert.ok(CROWD.includes('const stature = woman ? LOOK_STATURE.woman : LOOK_STATURE.man'))
  assert.ok(CROWD.includes('const hashedStep = (k: number, n: number) => h(k).mul(n).add(0.5).floor()'), 'round(h * n)')
  assert.ok(CROWD.includes('const hashedHeight = hashedStep(6, stature.span).add(stature.from)'))
  assert.ok(CROWD.includes("const n = (slot === 'head' ? WARDROBE.headSteps : WARDROBE.sliderSteps) - 1"))
  assert.ok(CROWD.includes('return select(custom, stepOf(slot), hashedStep(LOOK_HASHED_SLIDER[slot], n)).div(n)'))
  assert.ok(CROWD.includes("const height = select(custom, stepOf('height'), hashedHeight).mul(STATURE_STEP).add(WARDROBE.stature.min).div(HEIGHT_BASE)"))
  assert.ok(CROWD.includes('const STATURE_STEP = (WARDROBE.stature.max - WARDROBE.stature.min) / (WARDROBE.stature.steps - 1)'))
  assert.deepEqual(Object.keys(LOOK_HASHED_SLIDER), LOOK_BODY_SLIDERS.filter((s) => s !== 'height'))
  assert.deepEqual(new Set(Object.values(LOOK_HASHED_SLIDER)).size, 7, 'a link each')
  for (const k of Object.values(LOOK_HASHED_SLIDER)) assert.ok(k === 7 || k >= 9, `link ${k} is free of the pieces (1-5), the height (6) and the idle phase (8)`)
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

test('slot sizes: the pinned counts, every colour option a palette swatch, the piece slots on/off, the sliders\' steps', () => {
  const sizes = (body: LookBody) => Object.fromEntries(LOOK_SLOTS.map((s) => [s, lookSize(body, s)]))
  const common = {
    body: 4, height: 32, mass: 16, muscle: 16, shoulders: 16, hips: 16, legs: 16, posture: 16, head: 8,
    skin: 8, hairStyle: 2, hairColour: 9, tie: 2, eyewear: 2, bag: 2, cup: 2,
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
    for (const s of ['tie', 'eyewear', 'bag', 'cup', 'hairStyle'] as const) {
      assert.equal(lookOptions(b, s)[0].name, s === 'hairStyle' ? 'short' : 'none')
      assert.ok(lookOptions(b, s).every((x) => x.hex === null))
    }
    for (const s of LOOK_SLOTS) for (const x of lookOptions(b, s)) assert.match(x.name, /^[\x20-\x7e]+$/, 'ASCII names')
    // The height reads in metres; the other sliders count their steps.
    assert.deepEqual([lookOptions(b, 'height')[0].name, lookOptions(b, 'height')[31].name], ['1.50 m', '2.05 m'])
    assert.deepEqual([lookOptions(b, 'mass')[0].name, lookOptions(b, 'mass')[15].name, lookOptions(b, 'head')[7].name], ['1', '16', '8'])
  }
  assert.deepEqual(LOOK_SLOTS.slice(0, 9), ['body', ...LOOK_BODY_SLIDERS])
  assert.ok(Object.isFrozen(WARDROBE) && Object.isFrozen(WARDROBE.outfits) && Object.isFrozen(LOOK_FIELD))
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
})

// --- The packed words ------------------------------------------------------------------------------------------

test('LOOK_FIELD: bit 0 of the look word is the valid flag, its fields tile bits 1 to 25 (26 to 31 spare), the figure word is full, each field wide enough for its slot', () => {
  const used: [Set<number>, Set<number>] = [new Set([0]), new Set()]
  for (const slot of LOOK_SLOTS) {
    const [word, shift, width] = LOOK_FIELD[slot]
    const largest = Math.max(...BODIES.map((b) => lookSize(b, slot)))
    assert.ok(largest <= 1 << width, `${slot}: ${largest} options in ${width} bits`)
    assert.ok(shift + width <= 32)
    for (let b = shift; b < shift + width; b++) {
      assert.ok(!used[word].has(b), `${slot} overlaps bit ${b} of word ${word}`)
      used[word].add(b)
    }
    assert.equal(word, (LOOK_BODY_SLIDERS as readonly string[]).includes(slot) ? 1 : 0, `${slot} is in the ${word === 1 ? 'figure' : 'look'} word`)
  }
  assert.equal(used[0].size, 26)
  assert.ok([26, 27, 28, 29, 30, 31].every((b) => !used[0].has(b)), 'the legacy height and build bits are spare')
  assert.equal(used[1].size, 32)
  for (const [piece, bit] of Object.entries(LOOK_PIECE_BIT)) {
    const slot = piece === 'longHair' ? 'hairStyle' : piece === 'glasses' ? 'eyewear' : piece
    assert.deepEqual(LOOK_FIELD[slot as LookSlot], [0, 2 + bit, 1])
  }
  assert.deepEqual(LOOK_FIELD.body, [0, 1, 2])
  assert.deepEqual([LOOK_FIELD.height, LOOK_FIELD.mass, LOOK_FIELD.head], [[1, 0, 5], [1, 5, 4], [1, 29, 3]])
  assert.deepEqual([LEGACY_LOOK_FIELD.height, LEGACY_LOOK_FIELD.build, LEGACY_LOOK_FIELD.steps], [[26, 3], [29, 3], 8])
})

test('packLook/packFigure/unpackLook round-trip every slot value of every body; a packed look word always has bit 0 set', () => {
  let count = 0
  for (const b of BODIES) {
    for (const slot of LOOK_SLOTS) {
      if (slot === 'body') continue
      for (let v = 0; v < lookSize(b, slot); v++) {
        const look = withSlot(zero(b), slot, v)
        const [word, figure] = words(look)
        assert.equal(word & 1, 1)
        for (const w of [word, figure]) assert.ok(w >= 0 && w <= 0xffffffff && Number.isInteger(w))
        assert.deepEqual(unpackLook(word, figure), look, `${LOOK_BODIES[b]} ${slot}=${v}`)
        count++
      }
    }
    // Every slot at its last option at once.
    const full: Record<string, number> = {}
    for (const s of LOOK_SLOTS) full[s] = s === 'body' ? b : lookSize(b, s) - 1
    assert.deepEqual(unpackLook(...words(full as Look)), full)
  }
  assert.ok(count > 500)
  // The head's last step uses the figure word's top bits: the words are unsigned.
  const tall = withSlot(withSlot(zero(0), 'head', 7), 'height', 31)
  assert.ok(packFigure(tall) > 0x7fffffff)
  assert.deepEqual(unpackLook(...words(tall)), tall)
  // The look word's spare bits are zero; the sliders live in the figure word alone.
  assert.equal(packLook(tall) >>> 26, 0)
  assert.equal(packLook(tall), packLook(zero(0)))
  assert.equal(packFigure(withSlot(zero(0), 'shoes', 2)), packFigure(zero(0)))
})

test('unpackLook refuses LOOK_NONE, words outside u32, and fields outside the body\'s options', () => {
  assert.equal(unpackLook(LOOK_NONE, 0), null)
  assert.equal(unpackLook(LOOK_NONE, packFigure(zero(0))), null)
  for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 32 + 1, 2]) assert.equal(unpackLook(bad, 0), null)
  for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 32 + 1]) assert.equal(unpackLook(packLook(zero(0)), bad), null)
  const [suit, figure] = words(zero(0))
  assert.equal(unpackLook(suit | (3 << LOOK_FIELD.shoes[1]), figure), null, 'the suit has three shoes')
  assert.equal(unpackLook(suit | (9 << LOOK_FIELD.hairColour[1]), figure), null, 'nine hair colours')
  assert.equal(unpackLook(suit | (7 << LOOK_FIELD.top[1]), figure), null, 'seven suit cloths')
  assert.equal(unpackLook(packLook(zero(2)) | (4 << LOOK_FIELD.bottom[1]), figure), null, 'matching plus three dark trousers')
  assert.equal(packLook(withSlot(zero(0), 'shoes', 3)), LOOK_NONE, 'nothing outside the wardrobe packs')
  assert.equal(packFigure(withSlot(zero(0), 'shoes', 3)), 0)
  // Every value of the figure word is a figure: its fields are exactly as wide as their sliders.
  for (const figure of [0, 0xffffffff, 0x12345678, 0x80000001]) assert.notEqual(unpackLook(suit, figure), null)
  assert.equal(unpackLook(suit, 0xffffffff)!.height, 31)
  assert.equal(unpackLook(suit, 0xffffffff)!.head, 7)
})

test('lookMask: the pieces land where the crowd\'s vertex stage (crowdBody.ts) tests them (tie 2, bag 4, cup 8, long hair 16, glasses 32)', () => {
  assert.equal(lookMask(LOOK_NONE), 0)
  assert.equal(lookMask(packLook(zero(0))), 0)
  const pieces: [LookSlot, number][] = [['tie', 2], ['bag', 4], ['cup', 8], ['hairStyle', 16], ['eyewear', 32]]
  let all = zero(1)
  for (const [slot, bit] of pieces) {
    assert.equal(lookMask(packLook(withSlot(zero(1), slot, 1))), bit)
    all = withSlot(all, slot, 1)
  }
  const word = packLook(all)
  assert.equal(lookMask(word), 62)
  assert.equal((word >>> 2) & 62, 62, 'the wiring stage\'s expression')
  for (const [, bit] of pieces) assert.equal((lookMask(word) >> Math.log2(bit)) & 1, 1)
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

test('a look kept before the figure (fourteen slots) is upgraded, not refused: its height to a stature, its build to a mass, the rest the middle step', () => {
  const navy = legacyOf(LOOK_PRESETS[0].look, 4, 3)
  const up = { ...LOOK_PRESETS[0].look, height: 16, mass: 6, muscle: 8, shoulders: 8, hips: 8, legs: 8, posture: 8, head: 4 }
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
  assert.deepEqual([LOOK_SLIDER_MIDDLE.slider, LOOK_SLIDER_MIDDLE.head], [8, 4])
  // Outside the legacy catalogue: refused, as before.
  assert.equal(upgradeLegacyLook({ ...navy, height: 8 }), null)
  assert.equal(upgradeLegacyLook({ ...navy, build: -1 }), null)
  assert.equal(upgradeLegacyLook({ ...navy, shoes: 3 }), null, 'a suit has three shoes')
  assert.equal(upgradeLegacyLook({ ...navy, extra: 1 }), null)
  const { tie: _tie, ...fewer } = navy
  assert.equal(upgradeLegacyLook({ ...fewer, hat: 0 }), null, 'fourteen keys, the wrong ones')
  assert.equal(validateLook({ ...fewer, hat: 0 }), null)
  assert.equal(upgradeLegacyLook(LOOK_PRESETS[0].look), null, 'a new look is not a legacy one')
  // The legacy word (height and build in its top bits) upgrades the same way.
  let word = 1
  for (const s of LEGACY_LOOK_SLOTS) {
    const [shift] = s === 'height' ? LEGACY_LOOK_FIELD.height : s === 'build' ? LEGACY_LOOK_FIELD.build : [LOOK_FIELD[s as LookSlot][1]]
    word |= navy[s] << shift
  }
  assert.deepEqual(unpackLegacyLook(word >>> 0), up)
  assert.equal(unpackLegacyLook(LOOK_NONE), null)
  assert.equal(unpackLegacyLook((word | (3 << LOOK_FIELD.shoes[1])) >>> 0), null)
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
  const pantsuit = withLookSlot(suit, 'body', 2)!
  assert.equal(pantsuit.body, 2)
  assert.equal(pantsuit.bottom, 3, 'clamped to the last dark trouser')
  assert.equal(pantsuit.shoes, 2, 'kept')
  assert.notEqual(validateLook(pantsuit), null)
})

// --- The figure ------------------------------------------------------------------------------------------------

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
    assert.equal(look.hairStyle, hp(4) >= Math.fround(0.35) ? 1 : 0)
    assert.equal(look.eyewear, hp(5) >= Math.fround(0.78) ? 1 : 0)
    const stature = woman ? LOOK_STATURE.woman : LOOK_STATURE.man
    assert.equal(look.height, stature.from + Math.round(hp(6) * stature.span))
    assert.equal(look.mass, Math.round(hp(7) * 15))
    assert.equal(look.muscle, Math.round(hp(9) * 15))
    assert.equal(look.shoulders, Math.round(hp(10) * 15))
    assert.equal(look.hips, Math.round(hp(11) * 15))
    assert.equal(look.legs, Math.round(hp(12) * 15))
    assert.equal(look.posture, Math.round(hp(13) * 15))
    assert.equal(look.head, Math.round(hp(14) * 7))
    assert.equal(look.skin, idx(hc(1), 8))
    assert.equal(look.hairColour, hc(9) >= Math.fround(0.9) ? 8 : idx(hc(2), 8))
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
  assert.deepEqual(lookFromSeed(0), { body: 0, height: 26, mass: 11, muscle: 4, shoulders: 0, hips: 8, legs: 8, posture: 8, head: 4, skin: 3, hairStyle: 1, hairColour: 1, top: 1, bottom: 0, shirt: 2, shoes: 0, tie: 0, eyewear: 0, bag: 1, cup: 0 })
  assert.deepEqual(lookFromSeed(1), { body: 1, height: 28, mass: 8, muscle: 14, shoulders: 4, hips: 15, legs: 12, posture: 5, head: 1, skin: 0, hairStyle: 0, hairColour: 1, top: 4, bottom: 0, shirt: 3, shoes: 0, tie: 0, eyewear: 0, bag: 1, cup: 0 })
  assert.deepEqual(lookFromSeed(2), { body: 2, height: 11, mass: 15, muscle: 12, shoulders: 4, hips: 4, legs: 3, posture: 2, head: 7, skin: 2, hairStyle: 1, hairColour: 6, top: 5, bottom: 3, shirt: 4, shoes: 3, tie: 0, eyewear: 0, bag: 0, cup: 0 })
  assert.deepEqual(lookFromSeed(3), { body: 3, height: 18, mass: 1, muscle: 4, shoulders: 10, hips: 2, legs: 1, posture: 10, head: 3, skin: 3, hairStyle: 1, hairColour: 6, top: 4, bottom: 2, shirt: 1, shoes: 0, tie: 0, eyewear: 1, bag: 0, cup: 0 })
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
  near(rate((l) => l.hairStyle), 1 - LOOK_ODDS.longHair, 'long hair')
  near(rate((l) => l.bag, 0, 4), 1 - LOOK_ODDS.bagMan, 'a man\'s bag')
  near(rate((l) => l.bag, 2, 4), 1 - LOOK_ODDS.bagWoman, 'a woman\'s bag')
  near(rate((l) => (l.hairColour === 8 ? 1 : 0)), 1 - LOOK_ODDS.grey, 'grey')
  near(rate((l) => (l.bottom > 0 ? 1 : 0), 2, 4), 1 - LOOK_ODDS.darkTrousers, 'dark trousers')
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
})

// --- Presets ---------------------------------------------------------------------------------------------------

test('every preset validates, names are unique ASCII words, every body is dressed, and lookPreset finds them', () => {
  assert.ok(LOOK_PRESETS.length >= 8)
  assert.ok(Object.isFrozen(LOOK_PRESETS))
  const names = new Set<string>()
  const bodies = new Set<number>()
  for (const p of LOOK_PRESETS) {
    assert.match(p.name, /^[a-z][a-z ]*[a-z]$/)
    assert.ok(!names.has(p.name), p.name)
    names.add(p.name)
    assert.deepEqual(validateLook(p.look), p.look)
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.look))
    bodies.add(p.look.body)
    assert.deepEqual(unpackLook(...words(p.look)), p.look)
    assert.deepEqual(lookPreset(p.name), p)
    assert.deepEqual(lookPreset(` ${p.name.toUpperCase()} `), p)
    assert.ok(statureOf(p.look.height) >= 1.6 && statureOf(p.look.height) <= 1.9, `${p.name} stands ${statureOf(p.look.height)} m`)
  }
  assert.equal(bodies.size, 4)
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

test('a look code is fifteen symbols "XXXXX-XXXXX-XXXXX" that read back the same look, whatever the case or spacing', () => {
  const looks: Look[] = [...LOOK_PRESETS.map((p) => p.look), ...BODIES.map(zero)]
  for (let s = 0; s < 500; s++) looks.push(lookFromSeed(s))
  const codes = new Set<string>()
  for (const look of looks) {
    const code = formatLookCode(look)
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/, code)
    assert.deepEqual(parseLookCode(code), look)
    assert.deepEqual(parseLookCode(code.toLowerCase()), look)
    assert.deepEqual(parseLookCode(` ${code.replaceAll('-', '')} `), look)
    assert.deepEqual(parseLookCode(code.replaceAll('-', ' ')), look)
    codes.add(code)
  }
  assert.equal(codes.size, new Set(looks.map((l) => words(l).join(':'))).size, 'distinct looks give distinct codes')
  assert.equal(formatLookCode(withSlot(zero(0), 'shoes', 3)), '', 'nothing outside the wardrobe has a code')
  assert.equal(formatLookCode(LOOK_PRESETS[0].look), '00002-89JC7-H1W5Z')
})

test('a legacy eight-symbol code still reads, upgraded; the same old code gives the same new look everywhere', () => {
  const navy = legacyOf(LOOK_PRESETS[0].look, 4, 3)
  let word = 1
  for (const s of LEGACY_LOOK_SLOTS) {
    const [shift] = s === 'height' ? LEGACY_LOOK_FIELD.height : s === 'build' ? LEGACY_LOOK_FIELD.build : [LOOK_FIELD[s as LookSlot][1]]
    word |= navy[s] << shift
  }
  word >>>= 0
  const old = symbolsOf((BigInt(word) << 8n) | BigInt(crc8([word])), 8)
  const code = `${old.slice(0, 4)}-${old.slice(4)}`
  assert.deepEqual(parseLookCode(code), upgradeLegacyLook(navy))
  assert.deepEqual(parseLookCode(code.toLowerCase()), upgradeLegacyLook(navy))
  assert.equal(parseLookCode(code)!.height, 16)
  assert.equal(parseLookCode(code)!.mass, 6)
  // Worn and written down again, it is a fifteen-symbol code that reads the same.
  assert.deepEqual(parseLookCode(formatLookCode(parseLookCode(code)!)), parseLookCode(code))
  // Its corruption is still caught.
  for (let i = 0; i < 8; i++) for (const ch of ALPHABET) if (ch !== old[i]) assert.equal(parseLookCode(old.slice(0, i) + ch + old.slice(i + 1)), null)
})

test('parseLookCode refuses corruption: any one symbol changed, junk, the wrong length, nonzero lead bits, and a code for an invalid word', () => {
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
  assert.equal(tried, LOOK_PRESETS.length * 15 * 31)
  for (const junk of ['', ' ', 'hello', 'ABCD-EFG', 'ABCD-EFGHI', 'ABCDE-FGHJK-MNPQ', 'ABCDE-FGHJK-MNPQRS', 'ABCI-0000', 'ABCL-0000', 'ABCO-0000', 'ABCU-0000', 'ABCD_EFGH', '!!!!-!!!!', '12345678x', '00002-89JC7-H1W5I'])
    assert.equal(parseLookCode(junk), null, junk)
  assert.equal(parseLookCode(undefined as unknown as string), null)
  assert.equal(parseLookCode(12345678 as unknown as string), null)
  // A code whose checksum is right but whose words are not a look (the suit with shoes 3) is still refused.
  const [word, figure] = words(zero(0))
  const badWord = word | (3 << LOOK_FIELD.shoes[1])
  assert.equal(parseLookCode(symbolsOf((BigInt(badWord) << 40n) | (BigInt(figure) << 8n) | BigInt(crc8([badWord, figure])), 15)), null)
  // The three lead bits must be zero even when the checksum (which they are outside) is right.
  const good = (BigInt(word) << 40n) | (BigInt(figure) << 8n) | BigInt(crc8([word, figure]))
  assert.deepEqual(parseLookCode(symbolsOf(good, 15)), zero(0))
  assert.equal(parseLookCode(symbolsOf(good | (1n << 72n), 15)), null)
  assert.equal(parseLookCode(symbolsOf(good | (4n << 72n), 15)), null)
  // The legacy length: a checksum that is right but a word that is not a look.
  const legacyBad = (word | (3 << LOOK_FIELD.shoes[1])) >>> 0
  assert.equal(parseLookCode(symbolsOf((BigInt(legacyBad) << 8n) | BigInt(crc8([legacyBad])), 8)), null)
})

// --- The console's view ----------------------------------------------------------------------------------------

test('describeLook: one ASCII line per slot and the code, with the height in metres, swatches, matching trousers and the piece names', () => {
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
  assert.equal(at('top'), 'top        #1f2a44  [1/7]')
  assert.equal(at('bottom'), 'bottom     matching (#1f2a44)  [1/8]')
  assert.equal(at('tie'), 'tie        tie  [2/2]')
  assert.equal(at('eyewear'), 'eyewear    none  [1/2]')
  assert.equal(lines[LOOK_SLOTS.length], `code       ${formatLookCode(LOOK_PRESETS[0].look)}`)
  const grey = describeLook(withSlot(zero(2), 'hairColour', 8))
  assert.equal(grey[LOOK_SLOTS.indexOf('hairColour')], 'hairColour grey  [9/9]')
  assert.equal(grey[LOOK_SLOTS.indexOf('bottom')], 'bottom     matching (#1f2a44)  [1/4]')
  assert.deepEqual(describeLook(withSlot(zero(0), 'shoes', 3)), ['look: outside the wardrobe'])
})

test('changeLook: a slot by number or name (a height in metres too), a preset, a code, random and reset; every refusal names why; never outside the wardrobe', () => {
  const suit = LOOK_PRESETS[0].look
  const ok = (r: ReturnType<typeof changeLook>): Look => { assert.equal(r.error, null, r.error ?? ''); return r.look! }
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'top', value: '2' }, 0)).top, 1)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'HairStyle', value: 'long' }, 0)).hairStyle, 1)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'tie', value: 'NONE' }, 0)).tie, 0)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'body', value: 'skirt suit' }, 0)).body, 3)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'skin', value: lookOptions(0, 'skin')[2].name }, 0)).skin, 2)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'height', value: '32' }, 0)).height, 31)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'height', value: '1.80' }, 0)).height, 17)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'height', value: '1.80 m' }, 0)).height, 17)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'height', value: '2.05 m' }, 0)).height, 31)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'mass', value: '16' }, 0)).mass, 15)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'posture', value: '1' }, 0)).posture, 0)
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
    [{ kind: 'slot', slot: 'tie', value: 'bow' }, /no tie named 'bow': none, tie/],
    [{ kind: 'preset', name: 'tuxedo' }, /no preset named 'tuxedo': navy suit, /],
    [{ kind: 'code', code: 'ZZZZ-ZZZZ' }, /not a look code: 'ZZZZ-ZZZZ' \(fifteen symbols, XXXXX-XXXXX-XXXXX\)/],
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
