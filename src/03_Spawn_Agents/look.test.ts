// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The wardrobe is only closed if nothing drifts: the catalogue must be exactly the crowd's
 * palettes and pieces (crowd.ts cannot load in Node, it imports a WGSL file, so its source text is read instead),
 * the packed word must carry every slot back out unchanged with the pieces at the crowd's own bit positions, the
 * validator must refuse everything that is not an index into the catalogue, a look code must survive copying and
 * refuse corruption, every preset must be wearable, and the seed path must reproduce three's hash bit for bit.
 * What breaks if it is removed? A palette could grow a colour the crowd never wears, or a bit could move and
 * dress agent 0 in the wrong cloth.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildScale, changeLook, describeLook, formatLookCode, GREY_HAIR, heightScale, LOOK_BODIES, LOOK_FIELD, LOOK_HASH, LOOK_NONE, LOOK_ODDS,
  LOOK_PALETTE, LOOK_PIECE_BIT, LOOK_PRESETS, LOOK_SCALE, LOOK_SLOTS, lookFromSeed, lookMask, lookOptions, lookPreset, lookSize,
  lookSwatch, packLook, parseLookCode, shaderHash, unpackLook, validateLook, WARDROBE, withLookSlot,
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

test('the bodies, the piece bits, the grey, the hash chains and the odds are the crowd\'s', () => {
  const names = CROWD.match(/export const VARIANT_NAMES = \[([^\]]*)\] as const/)
  assert.ok(names)
  assert.deepEqual([...LOOK_BODIES], names[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')))
  assert.deepEqual(WARDROBE.bodies, LOOK_BODIES)
  const o = CROWD.match(/const O = \{ NONE: 0, TIE: (\d), BAG: (\d), CUP: (\d), LONG_HAIR: (\d), GLASSES: (\d) \} as const/)
  assert.ok(o, 'crowd.ts O bits found')
  assert.deepEqual(LOOK_PIECE_BIT, { tie: +o[1], bag: +o[2], cup: +o[3], longHair: +o[4], glasses: +o[5] })
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
  // Proportions: the same bases and ranges.
  assert.ok(CROWD.includes(`woman ? h(6).mul(${LOOK_SCALE.heightWoman.range}).add(${LOOK_SCALE.heightWoman.base}) : h(6).mul(${LOOK_SCALE.heightMan.range}).add(${LOOK_SCALE.heightMan.base})`))
  assert.ok(CROWD.includes(`h(7).mul(${LOOK_SCALE.build.range}).add(${LOOK_SCALE.build.base})`))
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

test('slot sizes: the pinned counts, every colour option a palette swatch, the piece slots on/off', () => {
  const sizes = (body: LookBody) => Object.fromEntries(LOOK_SLOTS.map((s) => [s, lookSize(body, s)]))
  const common = { body: 4, height: 8, build: 8, skin: 8, hairStyle: 2, hairColour: 9, tie: 2, eyewear: 2, bag: 2, cup: 2 }
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
  }
  assert.ok(Object.isFrozen(WARDROBE) && Object.isFrozen(WARDROBE.outfits) && Object.isFrozen(LOOK_FIELD))
})

test('lookSwatch: colours for colour slots, the top\'s cloth for matching trousers, null for pieces', () => {
  const suit = zero(0)
  assert.equal(lookSwatch(suit, 'top'), LOOK_PALETTE.suits[0])
  assert.equal(lookSwatch(suit, 'bottom'), LOOK_PALETTE.suits[0], 'matching')
  assert.equal(lookSwatch(withSlot(suit, 'bottom', 3), 'bottom'), LOOK_PALETTE.suits[2])
  assert.equal(lookSwatch(withSlot(zero(2), 'bottom', 1), 'bottom'), LOOK_PALETTE.darkTrousers[0])
  assert.equal(lookSwatch(withSlot(suit, 'hairColour', 8), 'hairColour'), GREY_HAIR)
  assert.equal(lookSwatch(suit, 'tie'), null)
  assert.equal(lookSwatch(suit, 'height'), null)
})

// --- The packed word -------------------------------------------------------------------------------------------

test('LOOK_FIELD: bit 0 is the valid flag, the fields tile the other 31 bits, each wide enough for its slot', () => {
  const used = new Set<number>([0])
  for (const slot of LOOK_SLOTS) {
    const [shift, width] = LOOK_FIELD[slot]
    const largest = Math.max(...BODIES.map((b) => lookSize(b, slot)))
    assert.ok(largest <= 1 << width, `${slot}: ${largest} options in ${width} bits`)
    for (let b = shift; b < shift + width; b++) {
      assert.ok(!used.has(b), `${slot} overlaps bit ${b}`)
      used.add(b)
    }
  }
  assert.equal(used.size, 32)
  for (const [piece, bit] of Object.entries(LOOK_PIECE_BIT)) {
    const slot = piece === 'longHair' ? 'hairStyle' : piece === 'glasses' ? 'eyewear' : piece
    assert.deepEqual(LOOK_FIELD[slot as LookSlot], [2 + bit, 1])
  }
  assert.deepEqual(LOOK_FIELD.body, [1, 2])
  assert.deepEqual([LOOK_FIELD.height, LOOK_FIELD.build], [[26, 3], [29, 3]])
})

test('packLook/unpackLook round-trip every slot value of every body; a packed word always has bit 0 set', () => {
  let words = 0
  for (const b of BODIES) {
    for (const slot of LOOK_SLOTS) {
      if (slot === 'body') continue
      for (let v = 0; v < lookSize(b, slot); v++) {
        const look = withSlot(zero(b), slot, v)
        const word = packLook(look)
        assert.equal(word & 1, 1)
        assert.ok(word >= 0 && word <= 0xffffffff && Number.isInteger(word))
        assert.deepEqual(unpackLook(word), look, `${LOOK_BODIES[b]} ${slot}=${v}`)
        words++
      }
    }
    // Every slot at its last option at once.
    const full: Record<string, number> = {}
    for (const s of LOOK_SLOTS) full[s] = s === 'body' ? b : lookSize(b, s) - 1
    assert.deepEqual(unpackLook(packLook(full as Look)), full)
  }
  assert.ok(words > 200)
  // Build at 7 uses the top bits: the word is unsigned.
  const tall = withSlot(withSlot(zero(0), 'build', 7), 'height', 7)
  assert.ok(packLook(tall) > 0x7fffffff)
  assert.deepEqual(unpackLook(packLook(tall)), tall)
})

test('unpackLook refuses LOOK_NONE, words outside u32, and fields outside the body\'s options', () => {
  assert.equal(unpackLook(LOOK_NONE), null)
  for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 32 + 1, 2]) assert.equal(unpackLook(bad), null)
  const suit = packLook(zero(0))
  assert.equal(unpackLook(suit | (3 << LOOK_FIELD.shoes[0])), null, 'the suit has three shoes')
  assert.equal(unpackLook(suit | (9 << LOOK_FIELD.hairColour[0])), null, 'nine hair colours')
  assert.equal(unpackLook(suit | (7 << LOOK_FIELD.top[0])), null, 'seven suit cloths')
  assert.equal(unpackLook(packLook(zero(2)) | (4 << LOOK_FIELD.bottom[0])), null, 'matching plus three dark trousers')
  assert.equal(packLook(withSlot(zero(0), 'shoes', 3)), LOOK_NONE, 'nothing outside the wardrobe packs')
})

test('lookMask: the pieces land where crowd.ts agentXform tests them (tie 2, bag 4, cup 8, long hair 16, glasses 32)', () => {
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

test('withLookSlot changes one slot within the catalogue; a body change keeps what fits and clamps the rest', () => {
  const suit = withSlot(withSlot(zero(0), 'bottom', 7), 'shoes', 2)
  assert.deepEqual(withLookSlot(suit, 'tie', 1), { ...suit, tie: 1 })
  assert.equal(withLookSlot(suit, 'tie', 2), null)
  assert.equal(withLookSlot(suit, 'shoes', 3), null)
  assert.equal(withLookSlot(suit, 'shoes', -1), null)
  assert.equal(withLookSlot(suit, 'shoes', 1.5), null)
  assert.equal(withLookSlot(suit, 'body', 4), null)
  const pantsuit = withLookSlot(suit, 'body', 2)!
  assert.equal(pantsuit.body, 2)
  assert.equal(pantsuit.bottom, 3, 'clamped to the last dark trouser')
  assert.equal(pantsuit.shoes, 2, 'kept')
  assert.notEqual(validateLook(pantsuit), null)
})

// --- Proportions -----------------------------------------------------------------------------------------------

test('heightScale/buildScale span exactly the crowd\'s hashed ranges, per body', () => {
  assert.equal(heightScale(zero(0)), 0.94)
  assert.equal(heightScale(withSlot(zero(0), 'height', 7)), 0.94 + 0.14)
  assert.equal(heightScale(zero(2)), 0.92)
  assert.ok(Math.abs(heightScale(withSlot(zero(3), 'height', 7)) - 1.02) < 1e-12)
  assert.equal(buildScale(zero(1)), 0.94)
  assert.ok(Math.abs(buildScale(withSlot(zero(1), 'build', 7)) - 1.08) < 1e-12)
  assert.ok(heightScale(withSlot(zero(0), 'height', 3)) < heightScale(withSlot(zero(0), 'height', 4)))
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
    assert.deepEqual(unpackLook(packLook(look)), look)
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
    assert.equal(look.height, Math.round(hp(6) * 7))
    assert.equal(look.build, Math.round(hp(7) * 7))
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
  assert.deepEqual(lookFromSeed(0), { body: 0, height: 6, build: 5, skin: 3, hairStyle: 1, hairColour: 1, top: 1, bottom: 0, shirt: 2, shoes: 0, tie: 0, eyewear: 0, bag: 1, cup: 0 })
  assert.deepEqual(lookFromSeed(1), { body: 1, height: 7, build: 4, skin: 0, hairStyle: 0, hairColour: 1, top: 4, bottom: 0, shirt: 3, shoes: 0, tie: 0, eyewear: 0, bag: 1, cup: 0 })
  assert.deepEqual(lookFromSeed(2), { body: 2, height: 3, build: 7, skin: 2, hairStyle: 1, hairColour: 6, top: 5, bottom: 3, shirt: 4, shoes: 3, tie: 0, eyewear: 0, bag: 0, cup: 0 })
  assert.deepEqual(lookFromSeed(3), { body: 3, height: 6, build: 0, skin: 3, hairStyle: 1, hairColour: 6, top: 4, bottom: 2, shirt: 1, shoes: 0, tie: 0, eyewear: 1, bag: 0, cup: 0 })
  const n = 20000
  const rate = (pick: (l: Look) => number, from = 0, step = 1) => {
    let sum = 0, count = 0
    for (let s = from; s < n; s += step) { sum += pick(lookFromSeed(s)); count++ }
    return sum / count
  }
  const near = (got: number, want: number, name: string) => assert.ok(Math.abs(got - want) < 0.03, `${name}: ${got.toFixed(3)} vs ${want}`)
  near(rate((l) => l.tie), 1 - LOOK_ODDS.tie, 'tie')
  near(rate((l) => l.cup), 1 - LOOK_ODDS.cup, 'cup')
  near(rate((l) => l.eyewear), 1 - LOOK_ODDS.glasses, 'glasses')
  near(rate((l) => l.hairStyle), 1 - LOOK_ODDS.longHair, 'long hair')
  near(rate((l) => l.bag, 0, 4), 1 - LOOK_ODDS.bagMan, 'a man\'s bag')
  near(rate((l) => l.bag, 2, 4), 1 - LOOK_ODDS.bagWoman, 'a woman\'s bag')
  near(rate((l) => (l.hairColour === 8 ? 1 : 0)), 1 - LOOK_ODDS.grey, 'grey')
  near(rate((l) => (l.bottom > 0 ? 1 : 0), 2, 4), 1 - LOOK_ODDS.darkTrousers, 'dark trousers')
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
    assert.deepEqual(unpackLook(packLook(p.look)), p.look)
    assert.deepEqual(lookPreset(p.name), p)
    assert.deepEqual(lookPreset(` ${p.name.toUpperCase()} `), p)
  }
  assert.equal(bodies.size, 4)
  assert.equal(lookPreset('tuxedo'), null)
  assert.equal(lookPreset(''), null)
})

// --- The look code ---------------------------------------------------------------------------------------------

test('a look code is eight symbols "XXXX-XXXX" that read back the same look, whatever the case or spacing', () => {
  const looks: Look[] = [...LOOK_PRESETS.map((p) => p.look), ...BODIES.map(zero)]
  for (let s = 0; s < 500; s++) looks.push(lookFromSeed(s))
  const codes = new Set<string>()
  for (const look of looks) {
    const code = formatLookCode(look)
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, code)
    assert.deepEqual(parseLookCode(code), look)
    assert.deepEqual(parseLookCode(code.toLowerCase()), look)
    assert.deepEqual(parseLookCode(` ${code.replace('-', '')} `), look)
    assert.deepEqual(parseLookCode(code.replace('-', ' ')), look)
    codes.add(code)
  }
  assert.equal(codes.size, new Set(looks.map(packLook)).size, 'distinct looks give distinct codes')
  assert.equal(formatLookCode(withSlot(zero(0), 'shoes', 3)), '', 'nothing outside the wardrobe has a code')
})

test('parseLookCode refuses corruption: any one symbol changed, junk, the wrong length, and a code for an invalid word', () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let tried = 0
  for (const p of LOOK_PRESETS) {
    const code = formatLookCode(p.look).replace('-', '')
    for (let i = 0; i < code.length; i++) {
      for (const ch of alphabet) {
        if (ch === code[i]) continue
        assert.equal(parseLookCode(code.slice(0, i) + ch + code.slice(i + 1)), null, `${code} with ${i} -> ${ch}`)
        tried++
      }
    }
    // Two symbols swapped.
    const swapped = code[1] + code[0] + code.slice(2)
    if (swapped !== code) assert.equal(parseLookCode(swapped), null)
  }
  assert.equal(tried, LOOK_PRESETS.length * 8 * 31)
  for (const junk of ['', ' ', 'hello', 'ABCD-EFG', 'ABCD-EFGHI', 'ABCI-0000', 'ABCL-0000', 'ABCO-0000', 'ABCU-0000', 'ABCD_EFGH', '!!!!-!!!!', '12345678x'])
    assert.equal(parseLookCode(junk), null, junk)
  assert.equal(parseLookCode(undefined as unknown as string), null)
  assert.equal(parseLookCode(12345678 as unknown as string), null)
  // A code whose checksum is right but whose word is not a look (the suit with shoes 3) is still refused.
  const word = packLook(zero(0)) | (3 << LOOK_FIELD.shoes[0])
  let crc = 0
  for (let i = 3; i >= 0; i--) {
    crc ^= (word >>> (i * 8)) & 0xff
    for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
  }
  let bits = (BigInt(word) << 8n) | BigInt(crc)
  let bad = ''
  for (let i = 0; i < 8; i++) { bad = alphabet[Number(bits & 31n)] + bad; bits >>= 5n }
  assert.equal(parseLookCode(bad), null)
})

// --- The console's view ----------------------------------------------------------------------------------------

test('describeLook: one ASCII line per slot and the code, with swatches, matching trousers and the piece names', () => {
  const lines = describeLook(LOOK_PRESETS[0].look)
  assert.equal(lines.length, LOOK_SLOTS.length + 1)
  for (const [i, slot] of LOOK_SLOTS.entries()) assert.ok(lines[i].startsWith(slot), lines[i])
  for (const line of lines) {
    assert.match(line, /^[\x20-\x7e]+$/)
    assert.doesNotMatch(line, /attack|kill|weapon|target|shoot|gun|violence|injur|damage/i)
  }
  assert.equal(lines[0], 'body       suit  [1/4]')
  assert.equal(lines[6], 'top        #1f2a44  [1/7]')
  assert.equal(lines[7], 'bottom     matching (#1f2a44)  [1/8]')
  assert.equal(lines[10], 'tie        tie  [2/2]')
  assert.equal(lines[11], 'eyewear    none  [1/2]')
  assert.equal(lines[14], `code       ${formatLookCode(LOOK_PRESETS[0].look)}`)
  const grey = describeLook(withSlot(zero(2), 'hairColour', 8))
  assert.equal(grey[5], 'hairColour grey  [9/9]')
  assert.equal(grey[7], 'bottom     matching (#1f2a44)  [1/4]')
  assert.deepEqual(describeLook(withSlot(zero(0), 'shoes', 3)), ['look: outside the wardrobe'])
})

test('changeLook: a slot by number or name, a preset, a code, random and reset; every refusal names why; never outside the wardrobe', () => {
  const suit = LOOK_PRESETS[0].look
  const ok = (r: ReturnType<typeof changeLook>): Look => { assert.equal(r.error, null, r.error ?? ''); return r.look! }
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'top', value: '2' }, 0)).top, 1)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'HairStyle', value: 'long' }, 0)).hairStyle, 1)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'tie', value: 'NONE' }, 0)).tie, 0)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'body', value: 'skirt suit' }, 0)).body, 3)
  assert.equal(ok(changeLook(suit, { kind: 'slot', slot: 'skin', value: lookOptions(0, 'skin')[2].name }, 0)).skin, 2)
  assert.deepEqual(ok(changeLook(suit, { kind: 'preset', name: ' Camel Blazer ' }, 0)), lookPreset('camel blazer')!.look)
  assert.deepEqual(ok(changeLook(suit, { kind: 'code', code: formatLookCode(LOOK_PRESETS[5].look).toLowerCase() }, 0)), LOOK_PRESETS[5].look)
  assert.deepEqual(ok(changeLook(suit, { kind: 'random', seed: 77 }, 0)), lookFromSeed(77))
  assert.deepEqual(ok(changeLook(suit, { kind: 'reset' }, 1337)), lookFromSeed(1337))
  for (const [change, why] of [
    [{ kind: 'slot', slot: 'hat', value: '1' }, /no slot named 'hat': body, height/],
    [{ kind: 'slot', slot: 'top', value: '0' }, /top has \d+ options \(1-\d+\)/],
    [{ kind: 'slot', slot: 'top', value: '99' }, /top has \d+ options/],
    [{ kind: 'slot', slot: 'tie', value: 'bow' }, /no tie named 'bow': none, tie/],
    [{ kind: 'preset', name: 'tuxedo' }, /no preset named 'tuxedo': navy suit, /],
    [{ kind: 'code', code: 'ZZZZ-ZZZZ' }, /not a look code/],
    [{ kind: 'random', seed: Number.NaN }, /seed must be a number/],
  ] as const) {
    const r = changeLook(suit, change, 0)
    assert.equal(r.look, null)
    assert.match(r.error ?? '', why)
  }
  assert.match(changeLook(withSlot(zero(0), 'shoes', 3), { kind: 'reset' }, 0).error ?? '', /outside the wardrobe/)
  // Every result validates, and the input is never touched.
  const before = { ...suit }
  for (const c of [{ kind: 'slot', slot: 'body', value: '2' }, { kind: 'random', seed: 5 }] as const) assert.ok(validateLook(changeLook(suit, c, 0).look))
  assert.deepEqual(suit, before)
})
