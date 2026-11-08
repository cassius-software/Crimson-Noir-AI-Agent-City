// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is what a person may look like: a body, its figure (the eight body sliders of
 * humanoid.ts: stature, mass, muscle, shoulders, hips, legs, posture, head), its face (the seven face sliders: brow,
 * jaw, chin, cheek, nose, eyes, lips; an age; a skin undertone; a hair style), an outfit and its colours chosen from
 * the city's own business-casual wardrobe (its outer layer a jacket, shirt sleeves or a coat; a trim on the lapels,
 * the collar and the cuffs; a scarf), packed into the four words the crowd shader reads (the look word, the figure
 * word, the face word and the wardrobe word). The wardrobe is closed by construction: every slot is an index into the
 * four bodies crowd.ts draws, the optional pieces it carries (a tie, a bag, a cup, the hair in its styles, glasses,
 * the face itself, a coat, a scarf), the colour palettes it already paints people with and the steps of each slider, so no stored value, no
 * typed command and no shared code can dress anyone in anything the crowd does not wear today. Those four words are
 * the first of a look genome of sixteen (LOOK_WORDS): the words after them hold what the catalogue has grown since
 * (word 4, the skin word: the ten tones of the Monk Skin Tone Scale beside the eight older ones, vitiligo, freckles),
 * and every field of them is 0 for "as before", so a look of the older layouts is the same look with those words
 * zero, its code is the same code, and the crowd draws it the same. The same module
 * reproduces the choice the shader's hash makes for an agent (lookFromSeed), so a returning visitor's look and an
 * agent's hashed look are the same kind of record; a short code with a checksum lets a look be written down and
 * shared; describeLook is the console's view of it. A look kept before the layers existed (twenty-nine slots, a
 * twenty-one-symbol code), before the face (twenty slots, a fifteen-symbol code) or before the figure (fourteen
 * slots, an eight-symbol code) is upgraded on the way in: the wardrobe to the jacket, a matching trim and no scarf,
 * the face to the base face, a height and build to a stature and a mass. Pure: no DOM, no GPU, no clock, no randomness.
 * What breaks if it is removed? The customizer would have no catalogue, nothing could be saved or shared, and the
 * crowd's per-agent attributes would have no agreed bit layout to carry.
 */
import { HEIGHT_BASE, type BodyShape, type FaceShape } from './humanoid.ts'

/** The four bodies crowd.ts draws, in draw-list order (an agent's hashed body is its index modulo four). */
export const LOOK_BODIES = ['suit', 'smart casual', 'pantsuit', 'skirt suit'] as const
export type LookBody = 0 | 1 | 2 | 3

/**
 * The bit each optional piece has in the crowd's per-person mask (humanoid.ts PIECE); bit 0 is "no option". The hair
 * is pieces (the cap, long hair, a bob, a bun) chosen by the hair style; `face` is the features, which the eye pass
 * draws and the shadow pass leaves out.
 */
export const LOOK_PIECE_BIT = Object.freeze({
  tie: 1, bag: 2, cup: 3, longHair: 4, glasses: 5, hairCap: 6, bob: 7, bun: 8, face: 9, coat: 10, scarf: 11,
  volume: 12, topBun: 13, ponytail: 14, wrap: 15, turban: 16, hat: 17, brim: 18,
})

/**
 * The crowd's colour palettes, verbatim (crowd.ts `PALETTE`, pinned by look.test.ts against the source). Every
 * cloth is a business-casual one: suits, blazers, chinos, shirts, blouses, skirts, office shoes, a bag's leather.
 * `skin` is the eight tones the crowd wore first; `monk` the ten of the Monk Skin Tone Scale (Dr. Ellis Monk, published
 * by Google under CC BY 4.0: NOTICE.md), lightest to deepest, which the hashed crowd is drawn from and which carry
 * the skin slot past the older tones (options 8 to 17).
 */
export const LOOK_PALETTE = Object.freeze({
  skin: Object.freeze([0xf3d2b8, 0xe8b894, 0xd29f79, 0xb97f5a, 0x9a6444, 0x7a4a31, 0x5c3522, 0xe5c0a0]),
  monk: Object.freeze([0xf6ede4, 0xf3e7db, 0xf7ead0, 0xeadaba, 0xd7bd96, 0xa07e56, 0x825c43, 0x604134, 0x3a312a, 0x292420]),
  hair: Object.freeze([0x1b1512, 0x2a1d14, 0x3b2618, 0x5e3c24, 0x7a3a1f, 0xb8935a, 0x8a6a48, 0x9c9a96]),
  iris: Object.freeze([0x3b2314, 0x5a3a22, 0x2a1a12, 0x4a6a4a, 0x5a7a9a, 0x7a5a3a]),
  suits: Object.freeze([0x1f2a44, 0x33363b, 0x5b6068, 0x1a1a1c, 0x4a3b2e, 0x2d4a73, 0x3d4550]),
  blazers: Object.freeze([0x9c7a54, 0x243352, 0x6e7278, 0x5a5e3f, 0x5e2530, 0xd8cfbf, 0x44464a]),
  chinos: Object.freeze([0xb09a74, 0x6a6d70, 0x2a3448, 0x222222, 0xcfc6b2, 0x6b5a45]),
  shirts: Object.freeze([0xf2f2ef, 0xc8d8ec, 0xecd4d8, 0xd6d0e6, 0xdadcde, 0xe9ecf2]),
  casualShirts: Object.freeze([0xf2f2ef, 0x9fb7d6, 0xd9c7a8, 0x2e3a4a, 0xb9c4b0, 0xe0e0e0]),
  ties: Object.freeze([0x1c2c4c, 0x6a1e2a, 0x234a36, 0x55585c, 0x3a5f9a, 0x2b2b2e]),
  womenBlazers: Object.freeze([0x1f2a44, 0x2a2a2d, 0x8a2f3a, 0xe8e2d6, 0x6b7a8f, 0xb58b63, 0x3f5e5a]),
  womenTops: Object.freeze([0xe8e2d6, 0x1f2a44, 0x7d4e57, 0x5f6f82, 0xc8a27a, 0x2a2a2d]),
  darkTrousers: Object.freeze([0x1c1c1e, 0x2a3040, 0x3a3c40]),
  blouses: Object.freeze([0xf5f2ea, 0xefe6d2, 0xd2e6dc, 0xe8a894, 0xc9d6ea, 0xe7c9d3]),
  skirts: Object.freeze([0x1f2a44, 0x33363b, 0x1a1a1c, 0x5e2530, 0x9c7a54, 0x6e7278]),
  menShoes: Object.freeze([0x141414, 0x3a2618, 0x2a1a12]),
  casualShoes: Object.freeze([0x3a2618, 0x7a5230, 0x5a4636, 0x1c1c1c]),
  womenShoes: Object.freeze([0x141414, 0x3e1a1c, 0x7a5230, 0x2a2a3a]),
  bags: Object.freeze([0x1c1712, 0x4a2e1c, 0x2a2a2a, 0x6a4a30]),
  coats: Object.freeze([0x2b2b2e, 0x1f2a44, 0x4a3b2e, 0xb59a72, 0x5a5e5c, 0x3a2a24, 0x8a6a48]),
  trims: Object.freeze([0x141414, 0xe8e2d6, 0x5e2530, 0x1c2c4c, 0xb59a72, 0x6e7278, 0x3f5e5a]),
  scarves: Object.freeze([0x6a1e2a, 0x1c2c4c, 0xd9c7a8, 0x2a2a2d, 0x8a6a48, 0x3a5f9a, 0x9c9a96]),
  headwear: Object.freeze([0x1c1c22, 0xe9e4da, 0x1f2a44, 0x6a1e2a, 0x3f5e5a, 0xb59a72, 0x5a5e66, 0xc77d4a]),
})
export type PaletteName = keyof typeof LOOK_PALETTE

/** The grey the shader mixes hair to for one person in ten and with age (crowd.ts `vec3(0.6, 0.6, 0.58)`), the ninth hair colour. */
export const GREY_HAIR = 0x999994

/** The figure's slots: the body sliders, in the order the card shows them (humanoid.ts BodyShape's fields). */
export const LOOK_BODY_SLIDERS = ['height', 'mass', 'muscle', 'shoulders', 'hips', 'legs', 'posture', 'head'] as const
export type LookSlider = (typeof LOOK_BODY_SLIDERS)[number]

/** The face's slots: the face sliders, in the order the card shows them (humanoid.ts FaceShape's fields). */
export const LOOK_FACE_SLIDERS = ['brow', 'jaw', 'chin', 'cheek', 'nose', 'eyes', 'lips'] as const
export type LookFaceSlider = (typeof LOOK_FACE_SLIDERS)[number]

/**
 * The slots of a look, in the order the console lists them. Every slot is an index into a list of options; the
 * list may depend on the body (an outfit's cloths differ per body) and is given by lookOptions().
 */
export const LOOK_SLOTS = [
  'body', ...LOOK_BODY_SLIDERS, ...LOOK_FACE_SLIDERS,
  'skin', 'age', 'undertone', 'vitiligo', 'freckles', 'hairStyle', 'curl', 'hairColour', 'headwear', 'headwearColour',
  'layer', 'top', 'trim', 'bottom', 'shirt', 'shoes', 'tie', 'scarf', 'eyewear', 'bag', 'cup',
] as const
export type LookSlot = (typeof LOOK_SLOTS)[number]
export type Look = Readonly<Record<LookSlot, number>>

/**
 * The slots of the genome's later words (LOOK_FIELD's words 4 and up), each one's option 0 the look as it was before
 * the slot existed (no vitiligo, no freckles). A record may leave any of them out: it reads as 0, so a look kept
 * before they existed is accepted as it is, and every later slot added here must keep 0 meaning "as before".
 */
export const LOOK_GENOME_SLOTS = ['vitiligo', 'freckles', 'curl', 'headwear', 'headwearColour'] as const satisfies readonly LookSlot[]

/** The slots a look had before the genome's later words (the thirty-two of the four words): every one is required. */
export const LOOK_V4_SLOTS = LOOK_SLOTS.filter((s) => !(LOOK_GENOME_SLOTS as readonly string[]).includes(s))

/** The slots a look had before the wardrobe's layers (one layer, the jacket; no trim; no scarf). */
export const LOOK_V3_SLOTS = [
  'body', ...LOOK_BODY_SLIDERS, ...LOOK_FACE_SLIDERS,
  'skin', 'age', 'undertone', 'hairStyle', 'hairColour', 'top', 'bottom', 'shirt', 'shoes', 'tie', 'eyewear', 'bag', 'cup',
] as const

/** The slots a look had before the face (the body sliders, two hair styles, no age or undertone). */
export const LOOK_V2_SLOTS = [
  'body', ...LOOK_BODY_SLIDERS, 'skin', 'hairStyle', 'hairColour', 'top', 'bottom', 'shirt', 'shoes', 'tie', 'eyewear', 'bag', 'cup',
] as const
type V2Slot = (typeof LOOK_V2_SLOTS)[number]

/** The slots a look had before the figure (height and build were three bits each in the look word). */
export const LEGACY_LOOK_SLOTS = [
  'body', 'height', 'build', 'skin', 'hairStyle', 'hairColour', 'top', 'bottom', 'shirt', 'shoes', 'tie', 'eyewear', 'bag', 'cup',
] as const
type LegacySlot = (typeof LEGACY_LOOK_SLOTS)[number]

/** One option of a slot: a name for the console and the card, and the swatch when the option is a colour. */
export interface LookOption {
  readonly name: string
  readonly hex: number | null
}

/** The palettes one body's outfit draws from; `matching` adds a first "matching the top" trouser option. */
export interface Outfit {
  readonly top: PaletteName
  readonly bottom: PaletteName
  readonly matching: boolean
  readonly shirt: PaletteName
  readonly shoes: PaletteName
}

/** Vitiligo's patterns (WARDROBE.vitiligo), as crowd.ts draws them: 0 is none, as before the skin word. */
export const VITILIGO = Object.freeze({ none: 0, hands: 1, face: 2, handsAndFace: 3, scattered: 4, widespread: 5, oneSide: 6 })

/** The hair styles' indices (WARDROBE.hairStyle): the two the look had before the face keep their numbers, the five before the genome theirs. */
export const HAIR = Object.freeze({ short: 0, long: 1, bob: 2, bun: 3, bald: 4, afro: 8 })

/**
 * How a style's hair is painted over its pieces (crowd.ts, the hair's slot): as it grows, cropped close to the scalp,
 * faded to the skin at the sides and back, cornrows, braids, locs, twists, a side part, an undercut (the sides
 * shaved), a strip down the middle (the sides shaved), or waves round the crown. Every name is the cut's own, never
 * a people's.
 */
export const HAIR_TEXTURE = Object.freeze({ plain: 0, close: 1, fade: 2, rows: 3, braids: 4, locs: 5, twists: 6, part: 7, undercut: 8, strip: 9, waves: 10 })
type HairPiece = 'hairCap' | 'longHair' | 'bob' | 'bun' | 'volume' | 'topBun' | 'ponytail'
/** The hair pieces a style may wear (humanoid.ts PIECE), each one's bit in the mask. */
export const HAIR_PIECES: readonly HairPiece[] = Object.freeze(['hairCap', 'longHair', 'bob', 'bun', 'volume', 'topBun', 'ponytail'])

/**
 * The thirty-two hair styles: each a name, the hair pieces it wears and how its hair is painted. The first five are
 * the styles every look had before the genome (their numbers kept); the rest reach the hair's later shapes (a full
 * rounded shell, a puff on the crown, a tail) and its paints. Whatever the style, the curl pattern (WARDROBE.curl)
 * says how the hair's own texture reads.
 */
export const HAIR_STYLES: readonly { readonly name: string; readonly pieces: readonly HairPiece[]; readonly texture: number }[] = Object.freeze(([
  ['short', ['hairCap'], 'plain'],
  ['long', ['hairCap', 'longHair'], 'plain'],
  ['bob', ['hairCap', 'bob'], 'plain'],
  ['bun', ['hairCap', 'bun'], 'plain'],
  ['bald', [], 'plain'],
  ['buzz cut', ['hairCap'], 'close'],
  ['fade', ['hairCap'], 'fade'],
  ['side part', ['hairCap'], 'part'],
  ['afro', ['hairCap', 'volume'], 'plain'],
  ['tapered afro', ['hairCap', 'volume'], 'fade'],
  ['afro puff', ['hairCap', 'topBun'], 'plain'],
  ['top knot', ['hairCap', 'topBun'], 'fade'],
  ['ponytail', ['hairCap', 'ponytail'], 'plain'],
  ['braided ponytail', ['hairCap', 'ponytail'], 'braids'],
  ['cornrows', ['hairCap'], 'rows'],
  ['cornrow ponytail', ['hairCap', 'ponytail'], 'rows'],
  ['box braids', ['hairCap', 'longHair'], 'braids'],
  ['braided bun', ['hairCap', 'bun'], 'braids'],
  ['braided updo', ['hairCap', 'topBun'], 'braids'],
  ['locs', ['hairCap', 'longHair'], 'locs'],
  ['short locs', ['hairCap', 'bob'], 'locs'],
  ['locs updo', ['hairCap', 'topBun'], 'locs'],
  ['twists', ['hairCap'], 'twists'],
  ['long twists', ['hairCap', 'longHair'], 'twists'],
  ['twist-out', ['hairCap', 'volume'], 'twists'],
  ['layered', ['hairCap', 'bob', 'longHair'], 'plain'],
  ['half up', ['hairCap', 'longHair', 'bun'], 'plain'],
  ['undercut', ['hairCap'], 'undercut'],
  ['centre strip', ['hairCap'], 'strip'],
  ['waves', ['hairCap'], 'waves'],
  ['bun with fade', ['hairCap', 'bun'], 'fade'],
  ['side part bun', ['hairCap', 'bun'], 'part'],
] as const).map(([name, pieces, texture]) => Object.freeze({ name, pieces: Object.freeze([...pieces]), texture: HAIR_TEXTURE[texture] })))

/**
 * For each hair piece, a 32-bit set of the styles that wear it (bit s for style s): the crowd's vertex stage tests
 * `(set >> style) & 1` for each piece, so one style's pieces cost seven shifts, not a table. The paint likewise, a
 * set per bit of the texture's number.
 */
export const HAIR_PIECE_STYLES: Readonly<Record<HairPiece, number>> = Object.freeze(Object.fromEntries(HAIR_PIECES.map((piece) =>
  [piece, HAIR_STYLES.reduce((set, style, i) => (style.pieces.includes(piece) ? set | (1 << i) : set), 0) >>> 0])) as Record<HairPiece, number>)
export const HAIR_TEXTURE_BITS = 4
export const HAIR_TEXTURE_STYLES: readonly number[] = Object.freeze(Array.from({ length: HAIR_TEXTURE_BITS }, (_, bit) =>
  HAIR_STYLES.reduce((set, style, i) => (((style.texture >>> bit) & 1) === 1 ? set | (1 << i) : set), 0) >>> 0))

/**
 * The headwear (WARDROBE.headwear), each worn over the hair in a headwear cloth (LOOK_PALETTE.headwear): a hijab (the
 * WRAP piece: the head, the ears and the neck covered, the face open), a turban and a head wrap (the TURBAN piece,
 * in two fabrics), a kippah (painted on the crown), a durag, a beanie and a flat cap (the HAT piece; the cap adds
 * the BRIM). Worn as clothing, with no symbol printed on any of them.
 */
export const HEADWEAR = Object.freeze({ none: 0, hijab: 1, turban: 2, headWrap: 3, kippah: 4, durag: 5, beanie: 6, flatCap: 7 })
/** What each headwear covers: all the hair (a hijab, a turban, a head wrap), the crown's hair (a durag, a beanie, a flat cap: the length below shows), or none (a kippah). */
export const headwearCovers = (headwear: number): 'all' | 'crown' | 'none' =>
  headwear === HEADWEAR.hijab || headwear === HEADWEAR.turban || headwear === HEADWEAR.headWrap ? 'all'
    : headwear === HEADWEAR.durag || headwear === HEADWEAR.beanie || headwear === HEADWEAR.flatCap ? 'crown' : 'none'
/** The headwear's own pieces (humanoid.ts PIECE): the wrap, the turban, the hat, the flat cap's peak. */
export const headwearPieces = (headwear: number): readonly string[] =>
  headwear === HEADWEAR.hijab ? ['wrap'] : headwear === HEADWEAR.turban || headwear === HEADWEAR.headWrap ? ['turban']
    : headwear === HEADWEAR.flatCap ? ['hat', 'brim'] : headwear === HEADWEAR.durag || headwear === HEADWEAR.beanie ? ['hat'] : []
/** The hair pieces a crown cover leaves showing below it: the length, the bob's sides, a tail. */
const BELOW_CROWN: ReadonlySet<string> = new Set(['longHair', 'bob', 'ponytail'])

/**
 * The outer layer's indices (WARDROBE.layer): the jacket every body wore before the layers (0, so an old record is
 * one), shirt sleeves (the same cloth in the shirt's colour: the jacket taken off) and a coat (the COAT piece over
 * everything, in a coat's cloth). The layer owns the `top` dye: a jacket draws from the body's palette, a coat from
 * the coats; under shirt sleeves it is not seen.
 */
export const LAYER = Object.freeze({ jacket: 0, shirt: 1, coat: 2 })

/**
 * The catalogue: what each slot may hold. `stature` is the height slider (32 steps, 1.50 m to 2.05 m: five bits);
 * `sliderSteps` the other body sliders' and the face sliders' (four bits each) but the head's (`headSteps`, three
 * bits); `ageSteps` the age's (three bits); `undertone` the skin's cast; `vitiligo` where the skin's paler patches
 * are (crowd.ts draws them from the rest position: the hands and wrists, round the eyes and the mouth, both, a few
 * patches anywhere, most of the skin, or one side of the body); `freckles` how many; `outfits` is per body, mirroring crowd.ts's
 * four fragment branches: the suit's trousers match the jacket (the hashed crowd) or take another suit cloth; the
 * pantsuit's match the blazer or are dark trousers; the skirt suit's skirt and the smart-casual chinos have palettes
 * of their own.
 */
export const WARDROBE = Object.freeze({
  bodies: LOOK_BODIES,
  stature: Object.freeze({ steps: 32, min: 1.5, max: 2.05 }),
  sliderSteps: 16,
  headSteps: 8,
  ageSteps: 8,
  undertone: Object.freeze(['neutral', 'warm', 'cool', 'olive']),
  vitiligo: Object.freeze(['none', 'hands', 'face', 'hands and face', 'scattered', 'widespread', 'one side']),
  freckles: Object.freeze(['none', 'light', 'medium', 'dense']),
  hairStyle: Object.freeze(HAIR_STYLES.map((s) => s.name)),
  curl: Object.freeze(['as styled', '1A', '1B', '1C', '2A', '2B', '2C', '3A', '3B', '3C', '4A', '4B', '4C']),
  headwear: Object.freeze(['none', 'hijab', 'turban', 'head wrap', 'kippah', 'durag', 'beanie', 'flat cap']),
  layer: Object.freeze(['jacket', 'shirt sleeves', 'coat']),
  tie: Object.freeze(['none', 'tie']),
  eyewear: Object.freeze(['none', 'glasses']),
  bag: Object.freeze(['none', 'bag']),
  cup: Object.freeze(['none', 'cup']),
  outfits: Object.freeze([
    Object.freeze({ top: 'suits', bottom: 'suits', matching: true, shirt: 'shirts', shoes: 'menShoes' }),
    Object.freeze({ top: 'blazers', bottom: 'chinos', matching: false, shirt: 'casualShirts', shoes: 'casualShoes' }),
    Object.freeze({ top: 'womenBlazers', bottom: 'darkTrousers', matching: true, shirt: 'blouses', shoes: 'womenShoes' }),
    Object.freeze({ top: 'womenTops', bottom: 'skirts', matching: false, shirt: 'blouses', shoes: 'womenShoes' }),
  ] as readonly Outfit[]),
})

/**
 * The middle step of a slider: the base person of humanoid.ts (near enough for the body sliders: 8 of 0..15, 4 of
 * 0..7; exactly for the face sliders, whose step 8 is the base face), and the age an upgraded look is given.
 */
export const LOOK_SLIDER_MIDDLE = Object.freeze({ slider: 8, head: 4, age: 3 })

/** The look word's bit that says the hair is long (the LONG_HAIR piece): derived from the hair style, never a slot of its own. */
export const LONG_HAIR_BIT = 2 + LOOK_PIECE_BIT.longHair

/**
 * Where each slot lives: [word, first bit, width]. Word 0 is the look word: bit 0 says it is a look at all (LOOK_NONE
 * is "as hashed"); the tie, bag, cup and glasses sit at bit 2 + their crowd bit, so `(word >> 2) & 46` is their part
 * of the mask the crowd's vertex stage tests with `(mask >> opt) & 1` (bit 6, LONG_HAIR_BIT, is written from the
 * hair style and read back for agreement only); the colours follow; the age and the undertone take bits 26 to 30,
 * where the legacy height and build lived; bit 31 is spare. Word 1 is the figure word: the eight body sliders,
 * 5 + 6 × 4 + 3 = 32 bits. Word 2 is the face word: the seven face sliders at four bits each and the hair style at
 * three; bit 31 is spare. Word 3 is the wardrobe word: the layer at two bits, the trim and the scarf at three each
 * (0 is matching, or none); bits 8 to 31 are spare. Word 4 is the skin word: the skin's high bits (LOOK_FIELD_HIGH:
 * a Monk tone is option 8 and up, past the look word's three bits), vitiligo at three bits and freckles at two; bits
 * 7 to 31 are spare, and so are words 5 to 15 (LOOK_WORDS), which unpackGenome requires to be zero. Every width is
 * pinned to hold its slot's largest option count (with its high bits, for a slot that has them).
 */
export const LOOK_FIELD: Readonly<Record<LookSlot, readonly [word: number, shift: number, width: number]>> = Object.freeze({
  body: [0, 1, 2],
  tie: [0, 2 + LOOK_PIECE_BIT.tie, 1],
  bag: [0, 2 + LOOK_PIECE_BIT.bag, 1],
  cup: [0, 2 + LOOK_PIECE_BIT.cup, 1],
  eyewear: [0, 2 + LOOK_PIECE_BIT.glasses, 1],
  skin: [0, 8, 3],
  hairColour: [0, 11, 4],
  top: [0, 15, 3],
  bottom: [0, 18, 3],
  shirt: [0, 21, 3],
  shoes: [0, 24, 2],
  age: [0, 26, 3],
  undertone: [0, 29, 2],
  height: [1, 0, 5],
  mass: [1, 5, 4],
  muscle: [1, 9, 4],
  shoulders: [1, 13, 4],
  hips: [1, 17, 4],
  legs: [1, 21, 4],
  posture: [1, 25, 4],
  head: [1, 29, 3],
  brow: [2, 0, 4],
  jaw: [2, 4, 4],
  chin: [2, 8, 4],
  cheek: [2, 12, 4],
  nose: [2, 16, 4],
  eyes: [2, 20, 4],
  lips: [2, 24, 4],
  hairStyle: [2, 28, 3],
  layer: [3, 0, 2],
  trim: [3, 2, 3],
  scarf: [3, 5, 3],
  vitiligo: [4, 2, 3],
  freckles: [4, 5, 2],
  curl: [4, 9, 4],
  headwear: [4, 13, 3],
  headwearColour: [4, 16, 3],
})

/**
 * The slots that outgrew their first field: the value's bits past that field's width go here, [word, shift, width].
 * An older look's value fits its first field, so these bits are zero for it and its four words are what they were.
 */
export const LOOK_FIELD_HIGH: Readonly<Partial<Record<LookSlot, readonly [word: number, shift: number, width: number]>>> = Object.freeze({
  skin: [4, 0, 2],
  hairStyle: [4, 7, 2],
})

/** The genome's length in u32 words: the look, figure, face and wardrobe words, the skin word, and eleven spare. */
export const LOOK_WORDS = 16

/** The legacy look word's height and build fields (three bits each), read by the upgrade alone. */
export const LEGACY_LOOK_FIELD = Object.freeze({ height: [26, 3] as const, build: [29, 3] as const, steps: 8 })

/** The word that means "dressed as the hash dresses everyone": bit 0 clear. */
export const LOOK_NONE = 0

/**
 * The legacy proportions: scale = base + step / 7 × range of the base height (a woman's body spanned a narrower
 * range), and the width the same. The upgrade maps them onto the stature and the mass.
 */
const LEGACY_SCALE = Object.freeze({
  heightMan: Object.freeze({ base: 0.94, range: 0.14 }),
  heightWoman: Object.freeze({ base: 0.92, range: 0.1 }),
  build: Object.freeze({ base: 0.94, range: 0.14 }),
})

/**
 * The hashed crowd's stature, in steps of the height slider per body (crowd.ts: `from + round(h(6) × span)`): men
 * 1.64 m to 2.00 m, women 1.55 m to 1.87 m. The other sliders are hashed over their whole range from the vertex
 * chain's later links (LOOK_HASHED_SLIDER, LOOK_HASHED_FACE).
 */
export const LOOK_STATURE = Object.freeze({
  man: Object.freeze({ from: 8, span: 20 }),
  woman: Object.freeze({ from: 3, span: 18 }),
})
/** The link of the vertex hash chain (LOOK_HASH.pieces) each hashed body slider is rounded from (the height's is 6). */
export const LOOK_HASHED_SLIDER: Readonly<Record<Exclude<LookSlider, 'height'>, number>> = Object.freeze({
  mass: 7, muscle: 9, shoulders: 10, hips: 11, legs: 12, posture: 13, head: 14,
})
/** The link of the vertex chain each hashed face slider is rounded from. */
export const LOOK_HASHED_FACE: Readonly<Record<LookFaceSlider, number>> = Object.freeze({
  brow: 15, jaw: 16, chin: 17, cheek: 18, nose: 19, eyes: 20, lips: 21,
})
/** The link of the vertex chain that splits the hair that is not short into long, a bob or a bun (women), or bald (a few men). */
export const LOOK_HASHED_HAIR_SPLIT = 22
/** The link of the vertex chain the outer layer is drawn from (under LOOK_ODDS.shirtSleeves shirt sleeves, from LOOK_ODDS.coat a coat, else the jacket) and the one a scarf is worn above LOOK_ODDS.scarf on. */
export const LOOK_HASHED_LAYER = 23
export const LOOK_HASHED_SCARF = 24
/** The link of the vertex chain the headwear is drawn from (LOOK_ODDS: a hijab or a head wrap for a few women, a turban, a kippah or a flat cap for a few men). */
export const LOOK_HASHED_HEADWEAR = 25
/**
 * The links of the fragment chain (LOOK_HASH.colours) the age, the undertone and the iris colour are drawn from; the
 * trim's contrast (above LOOK_ODDS.trim it is a trim cloth, else matching) and that cloth; the scarf's cloth; whether
 * the skin has vitiligo (above LOOK_ODDS.vitiligo) and its pattern, freckles (above LOOK_ODDS.freckles) and how many;
 * `marks` and the two links after it, where on a person the patches and freckles fall (crowd.ts, not a slot).
 */
export const LOOK_HASHED_COLOUR = Object.freeze({ age: 7, undertone: 8, iris: 13, trim: 14, scarfCloth: 15, trimCloth: 16, vitiligo: 17, vitiligoPattern: 18, freckles: 19, frecklesDensity: 20, marks: 21, headwearCloth: 24, curl: 25 })

const isBody = (v: unknown): v is LookBody => v === 0 || v === 1 || v === 2 || v === 3
const womanBody = (body: LookBody): boolean => body >= 2
const hex6 = (n: number) => `#${n.toString(16).padStart(6, '0')}`
const swatches = (list: readonly number[]): LookOption[] => list.map((hex) => ({ name: hex6(hex), hex }))
const named = (names: readonly string[]): LookOption[] => names.map((name) => ({ name, hex: null }))
const steps = (n: number): LookOption[] => Array.from({ length: n }, (_, i) => ({ name: `${i + 1}`, hex: null }))
const isSlider = (slot: string): slot is LookSlider => (LOOK_BODY_SLIDERS as readonly string[]).includes(slot)
const isFaceSlider = (slot: string): slot is LookFaceSlider => (LOOK_FACE_SLIDERS as readonly string[]).includes(slot)

/** The stature a height step names, m (step 0 is 1.50 m, step 31 is 2.05 m). */
export function statureOf(step: number): number {
  const s = WARDROBE.stature
  const i = Number.isFinite(step) ? Math.min(s.steps - 1, Math.max(0, Math.round(step))) : 0
  return s.min + (i * (s.max - s.min)) / (s.steps - 1)
}
/** The height step nearest a stature in metres (clamped to the slider). */
export function statureStep(metres: number): number {
  const s = WARDROBE.stature
  if (!Number.isFinite(metres)) return LOOK_SLIDER_MIDDLE.slider
  return Math.min(s.steps - 1, Math.max(0, Math.round(((metres - s.min) / (s.max - s.min)) * (s.steps - 1))))
}
/** A Monk tone's name, as the scale numbers them: "mst-01" (lightest) to "mst-10" (deepest). */
const monkName = (i: number): string => `mst-${String(i + 1).padStart(2, '0')}`
/** The skin option of Monk tone `i` (0 is MST-01): the tones follow the eight older ones. */
export const monkSkin = (i: number): number => LOOK_PALETTE.skin.length + i
const stature = (): LookOption[] => Array.from({ length: WARDROBE.stature.steps }, (_, i) => ({ name: `${statureOf(i).toFixed(2)} m`, hex: null }))

/** The options a slot may hold for a body, in index order. */
export function lookOptions(body: LookBody, slot: LookSlot, layer: number = LAYER.jacket): readonly LookOption[] {
  const outfit = WARDROBE.outfits[body]
  switch (slot) {
    case 'body': return named(LOOK_BODIES)
    case 'height': return stature()
    case 'mass': case 'muscle': case 'shoulders': case 'hips': case 'legs': case 'posture': return steps(WARDROBE.sliderSteps)
    case 'head': return steps(WARDROBE.headSteps)
    case 'brow': case 'jaw': case 'chin': case 'cheek': case 'nose': case 'eyes': case 'lips': return steps(WARDROBE.sliderSteps)
    case 'skin': return [...swatches(LOOK_PALETTE.skin), ...LOOK_PALETTE.monk.map((hex, i) => ({ name: monkName(i), hex }))]
    case 'age': return steps(WARDROBE.ageSteps)
    case 'undertone': return named(WARDROBE.undertone)
    case 'vitiligo': return named(WARDROBE.vitiligo)
    case 'freckles': return named(WARDROBE.freckles)
    case 'hairStyle': return named(WARDROBE.hairStyle)
    case 'curl': return named(WARDROBE.curl)
    case 'headwear': return named(WARDROBE.headwear)
    case 'headwearColour': return swatches(LOOK_PALETTE.headwear)
    case 'hairColour': return [...swatches(LOOK_PALETTE.hair), { name: 'grey', hex: GREY_HAIR }]
    case 'layer': return named(WARDROBE.layer)
    // The layer owns the top's dye: a coat draws from the coats, as many as the body's own jacket palette holds (the slot's width is the jacket's).
    case 'top': return layer === LAYER.coat ? swatches(LOOK_PALETTE.coats).slice(0, LOOK_PALETTE[outfit.top].length) : swatches(LOOK_PALETTE[outfit.top])
    case 'trim': return [{ name: 'matching', hex: null }, ...swatches(LOOK_PALETTE.trims)]
    case 'scarf': return [{ name: 'none', hex: null }, ...swatches(LOOK_PALETTE.scarves)]
    case 'bottom': return [...(outfit.matching ? [{ name: 'matching', hex: null }] : []), ...swatches(LOOK_PALETTE[outfit.bottom])]
    case 'shirt': return swatches(LOOK_PALETTE[outfit.shirt])
    case 'shoes': return swatches(LOOK_PALETTE[outfit.shoes])
    case 'tie': return named(WARDROBE.tie)
    case 'eyewear': return named(WARDROBE.eyewear)
    case 'bag': return named(WARDROBE.bag)
    case 'cup': return named(WARDROBE.cup)
  }
}

/** How many options a slot has for a body. */
export const lookSize = (body: LookBody, slot: LookSlot): number => lookOptions(body, slot).length

/**
 * The cloth a matching option wears: matching trousers the jacket's, whatever layer is over it (the shader reads the
 * jacket's palette for them, a coat hides the jacket, not the trousers); a matching trim the outer layer's (the top's
 * swatch: the coat's under a coat). Null for a body whose trousers never match.
 */
export function matchingSwatch(look: Look, slot: 'bottom' | 'trim'): number | null {
  const body = look.body as LookBody
  if (slot === 'trim') return lookSwatch(look, 'top')
  return WARDROBE.outfits[body].matching ? lookOptions(body, 'top', LAYER.jacket)[look.top]?.hex ?? null : null
}

/**
 * The swatch a colour slot shows (the top's: the coat's cloth under a coat; matching trousers and a matching trim as
 * matchingSwatch gives them), or null for a slot without one (a scarf not worn).
 */
export function lookSwatch(look: Look, slot: LookSlot): number | null {
  const body = look.body as LookBody
  const hex = lookOptions(body, slot, look.layer)[look[slot]]?.hex ?? null
  if (hex === null && ((slot === 'bottom' && look.bottom === 0) || (slot === 'trim' && look.trim === 0))) return matchingSwatch(look, slot)
  return hex
}

/** A body slider's step as the 0..1 the shader and humanoid.ts take (the height's is its stature, m). */
export function sliderValue(slot: LookSlider, step: number): number {
  if (slot === 'height') return statureOf(step)
  const n = slot === 'head' ? WARDROBE.headSteps : WARDROBE.sliderSteps
  return Math.min(n - 1, Math.max(0, step)) / (n - 1)
}

/** A face slider's step as the −1..1 the shader and humanoid.ts take: (step − 8) / 8, so step 8 is exactly the base face. */
export function faceValue(step: number): number {
  const mid = LOOK_SLIDER_MIDDLE.slider
  return (Math.min(WARDROBE.sliderSteps - 1, Math.max(0, step)) - mid) / mid
}

/** The body shape a look's figure describes (humanoid.ts: the card's silhouette and the eye height are drawn from it). */
export function bodyShapeOf(look: Look): BodyShape {
  return Object.freeze({
    height: statureOf(look.height),
    mass: sliderValue('mass', look.mass),
    muscle: sliderValue('muscle', look.muscle),
    shoulders: sliderValue('shoulders', look.shoulders),
    hips: sliderValue('hips', look.hips),
    legs: sliderValue('legs', look.legs),
    posture: sliderValue('posture', look.posture),
    head: sliderValue('head', look.head),
  })
}

/** The face shape a look's face sliders describe (humanoid.ts: the card's face view is drawn from it). */
export function faceShapeOf(look: Look): FaceShape {
  return Object.freeze({
    brow: faceValue(look.brow), jaw: faceValue(look.jaw), chin: faceValue(look.chin), cheek: faceValue(look.cheek),
    nose: faceValue(look.nose), eyes: faceValue(look.eyes), lips: faceValue(look.lips),
  })
}

/** The factor the crowd shader scales the base body by for a look: its stature over the base height (humanoid.ts). */
export function heightScale(look: Look): number {
  return statureOf(look.height) / HEIGHT_BASE
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** A v2 slot's option count: the hair had two styles then; the rest as today. */
const v2Size = (body: LookBody, slot: V2Slot): number => (slot === 'hairStyle' ? 2 : lookSize(body, slot))
/** The hair styles a look kept before the genome could hold (the face's five: HAIR_STYLES' first). */
const OLDER_HAIR_STYLES = 5
/** A v3 slot's option count: the five hair styles then; the rest as today. */
const v3Size = (body: LookBody, slot: LookSlot): number => (slot === 'hairStyle' ? OLDER_HAIR_STYLES : lookSize(body, slot))

/**
 * A look kept before the wardrobe's layers (exactly the twenty-nine v3 slots, each within its options), upgraded: the
 * jacket layer, a matching trim, no scarf. Null for anything else. Pure, so two browsers upgrade one old look to one
 * new look.
 */
export function upgradeFaceLook(raw: unknown): Look | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (Object.keys(r).length !== LOOK_V3_SLOTS.length || !isBody(r.body)) return null
  const body = r.body
  const out: Record<string, number> = {}
  for (const slot of LOOK_V3_SLOTS) {
    if (!hasOwn(r, slot)) return null
    const v = r[slot]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= v3Size(body, slot)) return null
    out[slot] = v + 0
  }
  out.layer = LAYER.jacket
  out.trim = 0
  out.scarf = 0
  return validateLook(out)
}
const legacySize = (body: LookBody, slot: LegacySlot): number => (slot === 'height' || slot === 'build' ? LEGACY_LOOK_FIELD.steps : v2Size(body, slot))

/**
 * A look kept before the face existed (exactly the twenty v2 slots, each within its options then), upgraded: the
 * face sliders to the middle step (the base face), the age to LOOK_SLIDER_MIDDLE.age, the undertone neutral, the
 * hair style carried (short or long keep their numbers). Null for anything else. Pure, so two browsers upgrade one
 * old look to one new look.
 */
export function upgradeFigureLook(raw: unknown): Look | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (Object.keys(r).length !== LOOK_V2_SLOTS.length || !isBody(r.body)) return null
  const body = r.body
  const out: Record<string, number> = {}
  for (const slot of LOOK_V2_SLOTS) {
    if (!hasOwn(r, slot)) return null
    const v = r[slot]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= v2Size(body, slot)) return null
    out[slot] = v + 0
  }
  for (const slot of LOOK_FACE_SLIDERS) out[slot] = LOOK_SLIDER_MIDDLE.slider
  out.age = LOOK_SLIDER_MIDDLE.age
  out.undertone = 0
  return upgradeFaceLook(out)
}

/**
 * A look kept before the figure existed (exactly the fourteen legacy slots, each within its options), upgraded: the
 * height step becomes the stature it drew (the legacy scale of the base height, to the nearest step), the build step
 * the mass, the rest of the figure the middle step, then the face as upgradeFigureLook gives it. Null for anything
 * else.
 */
export function upgradeLegacyLook(raw: unknown): Look | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (Object.keys(r).length !== LEGACY_LOOK_SLOTS.length || !isBody(r.body)) return null
  const body = r.body
  const old: Record<string, number> = {}
  for (const slot of LEGACY_LOOK_SLOTS) {
    if (!hasOwn(r, slot)) return null
    const v = r[slot]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= legacySize(body, slot)) return null
    old[slot] = v + 0
  }
  const scale = womanBody(body) ? LEGACY_SCALE.heightWoman : LEGACY_SCALE.heightMan
  const metres = (scale.base + (old.height / (LEGACY_LOOK_FIELD.steps - 1)) * scale.range) * HEIGHT_BASE
  const out: Record<string, number> = { ...old }
  delete out.build
  out.height = statureStep(metres)
  out.mass = Math.round((old.build / (LEGACY_LOOK_FIELD.steps - 1)) * (WARDROBE.sliderSteps - 1))
  for (const slot of LOOK_BODY_SLIDERS) if (slot !== 'height' && slot !== 'mass') out[slot] = slot === 'head' ? LOOK_SLIDER_MIDDLE.head : LOOK_SLIDER_MIDDLE.slider
  return upgradeFigureLook(out)
}

const SLOT_NAMES: ReadonlySet<string> = new Set(LOOK_SLOTS)
const GENOME_SLOT_NAMES: ReadonlySet<string> = new Set(LOOK_GENOME_SLOTS)

/**
 * The look a value is, or null: an object with every slot of the four words (LOOK_V4_SLOTS) and any of the genome's
 * later slots (LOOK_GENOME_SLOTS: one left out is 0, as before it existed), every one an integer within its options
 * for the body named, and no other key; or a twenty-nine-slot look from before the layers (upgradeFaceLook), a
 * twenty-slot look from before the face (upgradeFigureLook), or a legacy fourteen-slot look (upgradeLegacyLook).
 * Nothing else is accepted (not a string, an array, a float, a negative, an unknown key), so a stored or typed
 * record can only ever name what the crowd wears.
 */
export function validateLook(raw: unknown): Look | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const names = Object.keys(r)
  const keys = names.length
  if (keys === LEGACY_LOOK_SLOTS.length && hasOwn(r, 'build')) return upgradeLegacyLook(r)
  if (keys === LOOK_V2_SLOTS.length && !hasOwn(r, 'brow')) return upgradeFigureLook(r)
  if (keys === LOOK_V3_SLOTS.length && !hasOwn(r, 'layer')) return upgradeFaceLook(r)
  if (keys < LOOK_V4_SLOTS.length || keys > LOOK_SLOTS.length || !names.every((k) => SLOT_NAMES.has(k))) return null
  if (!isBody(r.body)) return null
  const body = r.body
  const out: Record<string, number> = {}
  for (const slot of LOOK_SLOTS) {
    if (!hasOwn(r, slot)) {
      if (!GENOME_SLOT_NAMES.has(slot)) return null
      out[slot] = 0
      continue
    }
    const v = r[slot]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= lookSize(body, slot)) return null
    out[slot] = v + 0
  }
  return Object.freeze(out) as Look
}

/**
 * A look with one slot changed, or null if the slot or the value is not in the catalogue. Changing the body keeps
 * every other slot where it still exists for the new body and moves the rest to that slot's last option.
 */
export function withLookSlot(look: Look, slot: LookSlot, value: number): Look | null {
  if (!Number.isInteger(value) || value < 0) return null
  if (slot === 'body') {
    if (!isBody(value)) return null
    const out: Record<string, number> = {}
    for (const s of LOOK_SLOTS) out[s] = s === 'body' ? value : Math.min(look[s], lookSize(value, s) - 1)
    return validateLook(out)
  }
  return validateLook({ ...look, [slot]: value })
}

const packWord = (look: Look, word: number): number => {
  let out = word === 0 ? 1 : 0
  for (const slot of LOOK_SLOTS) {
    const [w, shift, width] = LOOK_FIELD[slot]
    if (w === word) out |= (look[slot] & ((1 << width) - 1)) << shift
    const high = LOOK_FIELD_HIGH[slot]
    if (high && high[0] === word) out |= (look[slot] >>> width) << high[1]
  }
  // The long-hair piece's bit, from the style (the shader and lookMask build the hair bits from the style itself).
  if (word === 0 && look.hairStyle === HAIR.long) out |= 1 << LONG_HAIR_BIT
  return out >>> 0
}

/** The look word (crowd.look): bit 0 set, the body, the pieces, the colours, the age and the undertone. Only a valid look packs (else LOOK_NONE). */
export function packLook(look: Look): number {
  const valid = validateLook(look)
  return valid === null ? LOOK_NONE : packWord(valid, 0)
}

/** The figure word (crowd.figure's first): the eight body sliders' steps. 0 for a look outside the wardrobe (with LOOK_NONE beside it, it is nothing). */
export function packFigure(look: Look): number {
  const valid = validateLook(look)
  return valid === null ? 0 : packWord(valid, 1)
}

/** The face word (crowd.figure's second): the seven face sliders' steps and the hair style. 0 for a look outside the wardrobe. */
export function packFace(look: Look): number {
  const valid = validateLook(look)
  return valid === null ? 0 : packWord(valid, 2)
}

/** The wardrobe word (crowd.figure's third): the layer, the trim and the scarf. 0 for a look outside the wardrobe. */
export function packWardrobe(look: Look): number {
  const valid = validateLook(look)
  return valid === null ? 0 : packWord(valid, 3)
}

/**
 * The whole genome, LOOK_WORDS words: the look, figure, face and wardrobe words, then the skin word and the spare
 * words (zero). An older look's words 4 and up are all zero. LOOK_NONE and zeros for a look outside the wardrobe.
 */
export function packGenome(look: Look): number[] {
  const valid = validateLook(look)
  return Array.from({ length: LOOK_WORDS }, (_, w) => (valid === null ? 0 : packWord(valid, w)))
}

const isWord = (word: number): boolean => Number.isInteger(word) && word >= 0 && word <= 0xffffffff

/** Each genome word's bits that some field holds (words 4 and up: a bit outside them must be zero). */
const GENOME_BITS: readonly number[] = (() => {
  const bits = new Array<number>(LOOK_WORDS).fill(0)
  bits[0] = 1 | (1 << LONG_HAIR_BIT)
  for (const slot of LOOK_SLOTS) {
    const [w, shift, width] = LOOK_FIELD[slot]
    bits[w] |= ((1 << width) - 1) << shift
    const high = LOOK_FIELD_HIGH[slot]
    if (high) bits[high[0]] |= ((1 << high[2]) - 1) << high[1]
  }
  return bits.map((b) => b >>> 0)
})()

/**
 * The look a genome carries (four to LOOK_WORDS words; the words not given are zero), or null for LOOK_NONE, for any
 * set whose fields are outside the catalogue, for a bit set in words 4 and up that no field holds (a later layout's,
 * or a forgery), and for a look word whose long-hair bit disagrees with the face word's style (a forged pair: the
 * shader would draw one and the console report the other).
 */
export function unpackGenome(genome: ArrayLike<number>): Look | null {
  if (genome.length < 4 || genome.length > LOOK_WORDS) return null
  const words: number[] = []
  for (let w = 0; w < LOOK_WORDS; w++) {
    const v = w < genome.length ? genome[w] : 0
    if (!isWord(v)) return null
    if (w >= 4 && (v & ~GENOME_BITS[w]) !== 0) return null
    words.push(v)
  }
  const word = words[0]
  if ((word & 1) === 0) return null
  const out: Record<string, number> = {}
  for (const slot of LOOK_SLOTS) {
    const [w, shift, width] = LOOK_FIELD[slot]
    const high = LOOK_FIELD_HIGH[slot]
    out[slot] = ((words[w] >>> shift) & ((1 << width) - 1)) | (high ? ((words[high[0]] >>> high[1]) & ((1 << high[2]) - 1)) << width : 0)
  }
  const look = validateLook(out)
  if (look === null) return null
  if (((word >>> LONG_HAIR_BIT) & 1) !== (look.hairStyle === HAIR.long ? 1 : 0)) return null
  return look
}

/** The look the four words carry with the genome's later words zero (unpackGenome): what crowd.look and the figure's first three words name alone. */
export function unpackLook(word: number, figure: number, face: number, wardrobe: number): Look | null {
  return unpackGenome([word, figure, face, wardrobe])
}

/** The look a three-word record from before the layers carried (a twenty-one-symbol code), upgraded; null for anything else. */
export function unpackFaceLook(word: number, figure: number, face: number): Look | null {
  if (!isWord(word) || !isWord(figure) || !isWord(face) || (word & 1) === 0) return null
  const words = [word, figure, face] as const
  const out: Record<string, number> = {}
  for (const slot of LOOK_V3_SLOTS) {
    const [w, shift, width] = LOOK_FIELD[slot]
    out[slot] = (words[w as 0 | 1 | 2] >>> shift) & ((1 << width) - 1)
  }
  const look = upgradeFaceLook(out)
  if (look === null) return null
  if (((word >>> LONG_HAIR_BIT) & 1) !== (look.hairStyle === HAIR.long ? 1 : 0)) return null
  return look
}

/** A look-word slot of the layouts before the face: the hair style was bit 6 of the look word then; the rest as today. */
const wordField = (slot: V2Slot | LegacySlot): readonly [number, number] =>
  slot === 'hairStyle' ? [LONG_HAIR_BIT, 1] : slot === 'height' || slot === 'build' ? LEGACY_LOOK_FIELD[slot] : [LOOK_FIELD[slot][1], LOOK_FIELD[slot][2]]

/** The look a two-word record from before the face carried (a fifteen-symbol code), upgraded; null for anything else. */
export function unpackFigureLook(word: number, figure: number): Look | null {
  if (!isWord(word) || !isWord(figure) || (word & 1) === 0) return null
  const out: Record<string, number> = {}
  for (const slot of LOOK_V2_SLOTS) {
    const [w, shift, width] = LOOK_FIELD[slot]
    const [s, n] = w === 1 ? [shift, width] : wordField(slot)
    out[slot] = ((w === 1 ? figure : word) >>> s) & ((1 << n) - 1)
  }
  return upgradeFigureLook(out)
}

/** The look a legacy one-word record carried (height and build in its top bits), upgraded; null for anything else. */
export function unpackLegacyLook(word: number): Look | null {
  if (!isWord(word) || (word & 1) === 0) return null
  const out: Record<string, number> = {}
  for (const slot of LEGACY_LOOK_SLOTS) {
    const [shift, width] = wordField(slot)
    out[slot] = (word >>> shift) & ((1 << width) - 1)
  }
  return upgradeLegacyLook(out)
}

/**
 * The hair pieces a style wears under a headwear, as mask bits (HAIR_STYLES: the cap 64 for every style but bald, long
 * hair 16, a bob 128, a bun 256, the full shell, the crown's puff, a tail), with the headwear's own pieces: a hijab,
 * a turban or a head wrap covers all the hair; a durag, a beanie or a flat cap the crown's (the length below shows).
 * `near` false is the far body's mask: it has no headwear pieces, so under any cover it keeps the hair's cap (crowd.ts
 * paints it in the headwear's cloth) and nothing else the cover hides.
 */
export const hairBits = (style: number, headwear: number = HEADWEAR.none, near = true): number => {
  const covers = headwearCovers(headwear)
  let out = 0
  for (const piece of HAIR_STYLES[style]?.pieces ?? []) {
    if (covers === 'all' || (covers === 'crown' && !BELOW_CROWN.has(piece))) continue
    out |= 1 << LOOK_PIECE_BIT[piece]
  }
  if (covers !== 'none') {
    if (near) for (const piece of headwearPieces(headwear)) out |= 1 << LOOK_PIECE_BIT[piece as keyof typeof LOOK_PIECE_BIT]
    else out |= 1 << LOOK_PIECE_BIT.hairCap
  }
  return out >>> 0
}

/** The wardrobe's pieces, as mask bits: the coat 1024 when the layer is a coat, the scarf 2048 when one is worn. */
export const wardrobeBits = (wardrobe: number): number =>
  ((((wardrobe >>> LOOK_FIELD.layer[1]) & 3) === LAYER.coat ? 1 << LOOK_PIECE_BIT.coat : 0) | (((wardrobe >>> LOOK_FIELD.scarf[1]) & 7) !== 0 ? 1 << LOOK_PIECE_BIT.scarf : 0)) >>> 0

/**
 * The crowd's per-person piece mask for a packed look word, face word and wardrobe word, as the eye pass tests it
 * (tie at bit 1 … glasses at bit 5 from the look word; the hair bits from the face word's style; the coat and the
 * scarf from the wardrobe word; the face bit 9 always), 0 for LOOK_NONE. The shadow pass's mask is this without bit 9.
 */
export const lookMask = (word: number, face: number, wardrobe: number, skinWord = 0, near = true): number => {
  if ((word & 1) === 0) return 0
  const style = ((face >>> LOOK_FIELD.hairStyle[1]) & 7) | (((skinWord >>> LOOK_FIELD_HIGH.hairStyle![1]) & 3) << 3)
  const headwear = (skinWord >>> LOOK_FIELD.headwear[1]) & 7
  return (((word >>> 2) & 46) | hairBits(style, headwear, near) | wardrobeBits(wardrobe) | (1 << LOOK_PIECE_BIT.face)) >>> 0
}

/** Whether a look wears a piece (humanoid.ts PIECE) on the near body: the card's picture and the crowd's mask agree on it. */
export function lookWears(look: Look, piece: number): boolean {
  const g = packGenome(look)
  return piece === 0 || ((lookMask(g[0], g[2], g[3], g[4]) >>> piece) & 1) === 1
}

// --- The hash path, reproduced ---------------------------------------------------------------------------------

const f32 = Math.fround
const u32 = (f: number): number => (f <= 0 ? 0 : f >= 4294967295 ? 4294967295 : Math.trunc(f))

/** three's TSL `hash` (pcg), bit for bit, on the f32 the shader would hold: u32(seed) → [0, 1) as f32. */
export function shaderHash(seed: number): number {
  const state = (Math.imul(u32(f32(seed)), 747796405) + 2891336453) >>> 0
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0
  const result = ((word >>> 22) ^ word) >>> 0
  return f32(f32(result) * f32(1 / 2 ** 32))
}

/** The crowd's two hash chains for an agent: the vertex stage's (pieces, figure, face) and the fragment's (colours, age, undertone). */
export const LOOK_HASH = Object.freeze({ pieces: 13.37, colours: 7.919 })
/**
 * The thresholds a piece is drawn above (crowd.ts `step(edge, h(k))`); a woman's bag is commoner than a man's. The
 * hair: below `longHair` on link 4 is short; otherwise a woman's split link (LOOK_HASHED_HAIR_SPLIT) under `bob` is
 * long, under `bun` a bob, else a bun; a man's split link at or above `bald` is bald, else long. Two people in a
 * hundred have vitiligo (`vitiligo`), about one in six freckles (`freckles`), whatever their tone.
 */
export const LOOK_ODDS = Object.freeze({ tie: 0.3, bagMan: 0.7, bagWoman: 0.62, cup: 0.82, longHair: 0.35, glasses: 0.78, grey: 0.9, darkTrousers: 0.6, bob: 0.34, bun: 0.67, bald: 0.96, shirtSleeves: 0.2, coat: 0.85, scarf: 0.88, trim: 0.8, vitiligo: 0.98, freckles: 0.84, hijab: 0.95, headWrap: 0.93, turban: 0.975, kippah: 0.965, flatCap: 0.95 })

const pickIndex = (h: number, length: number): number => Math.min(u32(f32(h * f32(length - 0.001))), length - 1)
const above = (h: number, edge: number): number => (h >= f32(edge) ? 1 : 0)
/** A hashed step: round(h × n), as the shader does it (floor(h × n + 0.5)). */
const stepOf = (h: number, n: number): number => Math.min(n, Math.round(h * n))

/**
 * The look the crowd's hash gives an agent of this index (any non-negative integer; a profile seed does as well):
 * body = index mod 4, pieces, the figure and the face from the vertex chain, colours, the age, the undertone, the
 * Monk tone, vitiligo and freckles from the fragment chain, exactly as crowd.ts chooses them, each slider rounded to its step. What the words cannot carry
 * (the tie's cloth, the bag's leather, the skirt suit's hose, the iris) stays hashed in the shader, so it is not here.
 */
export function lookFromSeed(seed: number): Look {
  const s = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) % 4294967296 : 0
  const body = (s % 4) as LookBody
  const woman = womanBody(body)
  const hp = (k: number) => shaderHash(f32(f32(s) + f32(k * LOOK_HASH.pieces)))
  const hc = (k: number) => shaderHash(f32(f32(s) + f32(k * LOOK_HASH.colours)))
  const outfit = WARDROBE.outfits[body]
  const grey = above(hc(9), LOOK_ODDS.grey)
  let bottom: number
  if (body === 0) bottom = 0
  else if (body === 2) bottom = above(hc(10), LOOK_ODDS.darkTrousers) ? 1 + pickIndex(hc(4), LOOK_PALETTE.darkTrousers.length) : 0
  else bottom = pickIndex(hc(4), LOOK_PALETTE[outfit.bottom].length)
  const statureSteps = woman ? LOOK_STATURE.woman : LOOK_STATURE.man
  const slider = (slot: Exclude<LookSlider, 'height'>) => stepOf(hp(LOOK_HASHED_SLIDER[slot]), (slot === 'head' ? WARDROBE.headSteps : WARDROBE.sliderSteps) - 1)
  const face = (slot: LookFaceSlider) => stepOf(hp(LOOK_HASHED_FACE[slot]), WARDROBE.sliderSteps - 1)
  const notShort = above(hp(4), LOOK_ODDS.longHair) === 1
  const split = hp(LOOK_HASHED_HAIR_SPLIT)
  let hairStyle: number
  if (woman) hairStyle = !notShort ? HAIR.short : split < f32(LOOK_ODDS.bob) ? HAIR.long : split < f32(LOOK_ODDS.bun) ? HAIR.bob : HAIR.bun
  else hairStyle = above(split, LOOK_ODDS.bald) ? HAIR.bald : notShort ? HAIR.long : HAIR.short
  const wear = hp(LOOK_HASHED_HEADWEAR)
  const headwear = woman
    ? (above(wear, LOOK_ODDS.hijab) ? HEADWEAR.hijab : above(wear, LOOK_ODDS.headWrap) ? HEADWEAR.headWrap : HEADWEAR.none)
    : (above(wear, LOOK_ODDS.turban) ? HEADWEAR.turban : above(wear, LOOK_ODDS.kippah) ? HEADWEAR.kippah : above(wear, LOOK_ODDS.flatCap) ? HEADWEAR.flatCap : HEADWEAR.none)
  const layerLink = hp(LOOK_HASHED_LAYER)
  const layer = layerLink < f32(LOOK_ODDS.shirtSleeves) ? LAYER.shirt : above(layerLink, LOOK_ODDS.coat) ? LAYER.coat : LAYER.jacket
  // The top's dye is one link whichever palette the layer reads it from (both hold as many as the body's jacket palette, or more).
  const topSize = LOOK_PALETTE[outfit.top].length
  const look: Record<LookSlot, number> = {
    body,
    height: statureSteps.from + stepOf(hp(6), statureSteps.span),
    mass: slider('mass'),
    muscle: slider('muscle'),
    shoulders: slider('shoulders'),
    hips: slider('hips'),
    legs: slider('legs'),
    posture: slider('posture'),
    head: slider('head'),
    brow: face('brow'),
    jaw: face('jaw'),
    chin: face('chin'),
    cheek: face('cheek'),
    nose: face('nose'),
    eyes: face('eyes'),
    lips: face('lips'),
    // The hashed crowd wears the Monk scale's ten tones, evenly (the eight older tones are a chosen look's alone).
    skin: monkSkin(pickIndex(hc(1), LOOK_PALETTE.monk.length)),
    age: stepOf(hc(LOOK_HASHED_COLOUR.age), WARDROBE.ageSteps - 1),
    undertone: pickIndex(hc(LOOK_HASHED_COLOUR.undertone), WARDROBE.undertone.length),
    vitiligo: above(hc(LOOK_HASHED_COLOUR.vitiligo), LOOK_ODDS.vitiligo) ? 1 + pickIndex(hc(LOOK_HASHED_COLOUR.vitiligoPattern), WARDROBE.vitiligo.length - 1) : 0,
    freckles: above(hc(LOOK_HASHED_COLOUR.freckles), LOOK_ODDS.freckles) ? 1 + pickIndex(hc(LOOK_HASHED_COLOUR.frecklesDensity), WARDROBE.freckles.length - 1) : 0,
    hairStyle,
    // Every hashed head of hair has a curl pattern, 1A to 4C evenly (0, "as styled", is a chosen look's alone).
    curl: 1 + pickIndex(hc(LOOK_HASHED_COLOUR.curl), WARDROBE.curl.length - 1),
    headwear,
    headwearColour: headwear === HEADWEAR.none ? 0 : pickIndex(hc(LOOK_HASHED_COLOUR.headwearCloth), LOOK_PALETTE.headwear.length),
    hairColour: grey ? LOOK_PALETTE.hair.length : pickIndex(hc(2), LOOK_PALETTE.hair.length),
    layer,
    top: pickIndex(hc(3), topSize),
    trim: above(hc(LOOK_HASHED_COLOUR.trim), LOOK_ODDS.trim) ? 1 + pickIndex(hc(LOOK_HASHED_COLOUR.trimCloth), LOOK_PALETTE.trims.length) : 0,
    bottom,
    shirt: pickIndex(hc(5), LOOK_PALETTE[outfit.shirt].length),
    shoes: pickIndex(hc(6), LOOK_PALETTE[outfit.shoes].length),
    tie: above(hp(1), LOOK_ODDS.tie),
    scarf: above(hp(LOOK_HASHED_SCARF), LOOK_ODDS.scarf) ? 1 + pickIndex(hc(LOOK_HASHED_COLOUR.scarfCloth), LOOK_PALETTE.scarves.length) : 0,
    eyewear: above(hp(5), LOOK_ODDS.glasses),
    bag: above(hp(2), woman ? LOOK_ODDS.bagWoman : LOOK_ODDS.bagMan),
    cup: above(hp(3), LOOK_ODDS.cup),
  }
  return Object.freeze(look)
}

// --- Presets ----------------------------------------------------------------------------------------------------

export interface LookPreset {
  readonly name: string
  readonly look: Look
}

/** A look as written by hand: every slot of the four words, the genome's later slots optional (0 when left out). */
export type LookInput = Omit<Record<LookSlot, number>, LookGenomeSlot> & Partial<Record<LookGenomeSlot, number>>
export type LookGenomeSlot = (typeof LOOK_GENOME_SLOTS)[number]

const preset = (name: string, look: LookInput): LookPreset => {
  const valid = validateLook(look)
  if (valid === null) throw new Error(`look preset "${name}" is outside the wardrobe`)
  return Object.freeze({ name, look: valid })
}

/** A handful of named outfits per body for the picker; every one validates, and every cloth is the crowd's. */
export const LOOK_PRESETS: readonly LookPreset[] = Object.freeze([
  preset('navy suit', { body: 0, height: 16, mass: 7, muscle: 8, shoulders: 8, hips: 7, legs: 8, posture: 9, head: 4, brow: 8, jaw: 9, chin: 8, cheek: 7, nose: 8, eyes: 8, lips: 7, skin: 1, age: 3, undertone: 1, hairStyle: 0, hairColour: 1, layer: 0, top: 0, trim: 0, bottom: 0, shirt: 0, shoes: 0, tie: 1, scarf: 0, eyewear: 0, bag: 0, cup: 0 }),
  preset('charcoal suit', { body: 0, height: 20, mass: 9, muscle: 7, shoulders: 10, hips: 7, legs: 7, posture: 7, head: 4, brow: 9, jaw: 11, chin: 10, cheek: 8, nose: 9, eyes: 7, lips: 6, skin: 4, age: 5, undertone: 0, hairStyle: 0, hairColour: 0, layer: 2, top: 1, trim: 0, bottom: 0, shirt: 1, shoes: 1, tie: 1, scarf: 2, eyewear: 1, bag: 1, cup: 0 }),
  preset('camel blazer', { body: 1, height: 13, mass: 7, muscle: 6, shoulders: 7, hips: 8, legs: 9, posture: 8, head: 4, brow: 7, jaw: 7, chin: 7, cheek: 9, nose: 7, eyes: 9, lips: 9, skin: 2, age: 2, undertone: 3, hairStyle: 0, hairColour: 3, layer: 0, top: 0, trim: 2, bottom: 2, shirt: 0, shoes: 1, tie: 0, scarf: 3, eyewear: 0, bag: 0, cup: 1 }),
  preset('navy blazer', { body: 1, height: 17, mass: 11, muscle: 10, shoulders: 9, hips: 9, legs: 8, posture: 10, head: 3, brow: 8, jaw: 10, chin: 9, cheek: 8, nose: 10, eyes: 8, lips: 8, skin: 6, age: 4, undertone: 1, hairStyle: 4, hairColour: 0, layer: 0, top: 1, trim: 0, bottom: 0, shirt: 2, shoes: 0, tie: 0, scarf: 0, eyewear: 1, bag: 0, cup: 0 }),
  preset('burgundy pantsuit', { body: 2, height: 11, mass: 7, muscle: 7, shoulders: 6, hips: 9, legs: 8, posture: 9, head: 4, brow: 7, jaw: 6, chin: 7, cheek: 10, nose: 7, eyes: 9, lips: 10, skin: 3, age: 2, undertone: 2, hairStyle: 1, hairColour: 2, layer: 0, top: 2, trim: 2, bottom: 0, shirt: 0, shoes: 0, tie: 0, scarf: 0, eyewear: 0, bag: 1, cup: 0 }),
  preset('cream pantsuit', { body: 2, height: 16, mass: 5, muscle: 8, shoulders: 7, hips: 7, legs: 10, posture: 11, head: 4, brow: 8, jaw: 7, chin: 8, cheek: 9, nose: 8, eyes: 8, lips: 9, skin: 5, age: 6, undertone: 0, hairStyle: 3, hairColour: 8, layer: 0, top: 3, trim: 0, bottom: 1, shirt: 2, shoes: 2, tie: 0, scarf: 4, eyewear: 1, bag: 0, cup: 1 }),
  preset('navy skirt suit', { body: 3, height: 13, mass: 7, muscle: 6, shoulders: 6, hips: 10, legs: 8, posture: 8, head: 4, brow: 6, jaw: 7, chin: 6, cheek: 8, nose: 6, eyes: 10, lips: 9, skin: 0, age: 3, undertone: 2, hairStyle: 2, hairColour: 5, layer: 0, top: 1, trim: 0, bottom: 0, shirt: 0, shoes: 0, tie: 0, scarf: 1, eyewear: 1, bag: 1, cup: 0 }),
  preset('camel skirt suit', { body: 3, height: 9, mass: 9, muscle: 5, shoulders: 7, hips: 11, legs: 7, posture: 6, head: 5, brow: 9, jaw: 8, chin: 9, cheek: 11, nose: 9, eyes: 7, lips: 11, skin: 7, age: 4, undertone: 3, hairStyle: 1, hairColour: 6, layer: 0, top: 4, trim: 7, bottom: 2, shirt: 1, shoes: 1, tie: 0, scarf: 0, eyewear: 0, bag: 0, cup: 0 }),
])

/** The preset of that name (case and surrounding space ignored), or null. */
export function lookPreset(name: string): LookPreset | null {
  const key = name.trim().toLowerCase()
  return LOOK_PRESETS.find((p) => p.name === key) ?? null
}

// --- Builds -----------------------------------------------------------------------------------------------------

/** The body sliders a build sets: the frame's mass, muscle, shoulders and hips (the height, legs, posture and head stay the look's). */
export const LOOK_BUILD_SLIDERS = ['mass', 'muscle', 'shoulders', 'hips'] as const satisfies readonly LookSlider[]
export type LookBuildSlider = (typeof LOOK_BUILD_SLIDERS)[number]

export interface LookBuild {
  readonly name: string
  readonly steps: Readonly<Record<LookBuildSlider, number>>
}

/**
 * Eight builds over the body sliders, the somatotypes' span in plain words: from the slight and the lean (the
 * ectomorph's end), through the athletic, the muscular and the broad (the mesomorph's), to the stocky, the soft and the
 * full (the endomorph's). A build is a starting point, not a slot: it sets the four sliders it names to its steps, and
 * any of them moved after is the person's own; the height is never a build's (1.50 m to 2.05 m in every build).
 */
export const LOOK_BUILDS: readonly LookBuild[] = Object.freeze(([
  ['slight', [2, 4, 5, 6]],
  ['lean', [5, 7, 7, 7]],
  ['athletic', [7, 11, 10, 7]],
  ['muscular', [10, 15, 13, 8]],
  ['broad', [11, 10, 15, 9]],
  ['stocky', [12, 9, 11, 11]],
  ['soft', [12, 4, 8, 12]],
  ['full', [15, 6, 10, 15]],
] as const).map(([name, [mass, muscle, shoulders, hips]]) => Object.freeze({ name, steps: Object.freeze({ mass, muscle, shoulders, hips }) })))

/** The build of that name (case and surrounding space ignored), or null. */
export function lookBuild(name: string): LookBuild | null {
  const key = name.trim().toLowerCase()
  return LOOK_BUILDS.find((b) => b.name === key) ?? null
}

/** The look with a build's sliders set (everything else as it was), or null for no such build or a look outside the wardrobe. */
export function withBuild(look: Look, name: string): Look | null {
  const build = lookBuild(name)
  if (build === null || validateLook(look) === null) return null
  return validateLook({ ...look, ...build.steps })
}

/** The build a look's four sliders are exactly at, or null when they have been moved off every build. */
export function buildOf(look: Look): LookBuild | null {
  return LOOK_BUILDS.find((b) => LOOK_BUILD_SLIDERS.every((s) => look[s] === b.steps[s])) ?? null
}

/** The sliders a face shape sets: the head's size and the seven face sliders (every other slot is left as it was). */
export const LOOK_FACE_SHAPE_SLIDERS = ['head', ...LOOK_FACE_SLIDERS] as const
export interface LookFaceShape {
  readonly name: string
  readonly steps: Readonly<Record<(typeof LOOK_FACE_SHAPE_SLIDERS)[number], number>>
}

/**
 * Twenty-four face shapes over the head and face sliders, named by the shape alone (oval, round, square, heart, long,
 * diamond, triangle, rectangle and their softer, broader or more defined kin, then four that move one feature from
 * the base face), so a face is a starting point and every slider stays the person's own after it. Steps:
 * [head 0-7, brow, jaw, chin, cheek, nose, eyes, lips 0-15]; 8 (4 for the head) is the base face.
 */
export const LOOK_FACE_SHAPES: readonly LookFaceShape[] = Object.freeze(([
  ['oval', [4, 8, 8, 8, 8, 8, 8, 8]],
  ['soft oval', [4, 7, 7, 7, 9, 7, 9, 9]],
  ['defined oval', [4, 10, 10, 9, 7, 9, 7, 7]],
  ['round', [5, 7, 6, 6, 12, 7, 9, 9]],
  ['soft round', [5, 6, 5, 5, 13, 6, 10, 10]],
  ['full round', [6, 7, 7, 6, 14, 8, 8, 11]],
  ['square', [4, 10, 13, 10, 8, 8, 8, 7]],
  ['broad square', [5, 11, 15, 11, 9, 9, 7, 8]],
  ['soft square', [4, 9, 12, 9, 10, 8, 8, 9]],
  ['heart', [4, 9, 5, 6, 10, 7, 9, 9]],
  ['narrow heart', [3, 8, 4, 5, 9, 6, 10, 8]],
  ['full heart', [4, 9, 6, 7, 12, 7, 9, 11]],
  ['long', [3, 8, 8, 11, 6, 9, 8, 7]],
  ['narrow long', [2, 7, 7, 12, 5, 9, 7, 7]],
  ['defined long', [3, 10, 10, 12, 6, 10, 7, 6]],
  ['diamond', [4, 7, 7, 9, 13, 8, 8, 8]],
  ['narrow diamond', [3, 6, 6, 10, 12, 7, 8, 7]],
  ['triangle', [4, 6, 13, 9, 7, 8, 8, 8]],
  ['broad triangle', [5, 7, 15, 10, 8, 9, 7, 9]],
  ['rectangle', [4, 10, 12, 11, 7, 9, 8, 7]],
  ['broad nose', [4, 8, 8, 8, 9, 14, 8, 10]],
  ['narrow nose', [4, 8, 8, 8, 8, 2, 8, 7]],
  ['full lips', [4, 8, 8, 8, 9, 9, 8, 14]],
  ['wide eyes', [4, 8, 8, 8, 8, 8, 14, 9]],
] as const).map(([name, steps]) => Object.freeze({
  name,
  steps: Object.freeze(Object.fromEntries(LOOK_FACE_SHAPE_SLIDERS.map((s, i) => [s, steps[i]]))) as LookFaceShape['steps'],
})))

/** The face shape of that name (case and surrounding space ignored), or null. */
export function lookFaceShape(name: string): LookFaceShape | null {
  const key = name.trim().toLowerCase()
  return LOOK_FACE_SHAPES.find((f) => f.name === key) ?? null
}

/** The look with a face shape's sliders set (everything else as it was), or null for no such shape or a look outside the wardrobe. */
export function withFaceShape(look: Look, name: string): Look | null {
  const shape = lookFaceShape(name)
  if (shape === null || validateLook(look) === null) return null
  return validateLook({ ...look, ...shape.steps })
}

/** The face shape a look's head and face sliders are exactly at, or null when they have been moved off every shape. */
export function faceShapeNameOf(look: Look): LookFaceShape | null {
  return LOOK_FACE_SHAPES.find((f) => LOOK_FACE_SHAPE_SLIDERS.every((s) => look[s] === f.steps[s])) ?? null
}

// --- The look code ----------------------------------------------------------------------------------------------

/** 32 symbols without I, L, O and U, so a code read aloud or copied by hand is not mistaken. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** 140 bits: four zero bits, the look word, the figure word, the face word, the wardrobe word, then an 8-bit check over the four. */
const CODE_CHARS = 28
/** The code before the layers: 105 bits, one zero bit, the look, figure and face words, the check over the three. */
const V3_CODE_CHARS = 21
/** The code before the face: 75 bits, three zero bits, the look and figure words, the check over both. */
const V2_CODE_CHARS = 15
/** The legacy code: 40 bits, the one word then its check. */
const LEGACY_CODE_CHARS = 8

/** CRC-8 (polynomial 0x07) over the words' bytes, high word first: any single mistyped symbol (a burst of five bits) is caught. */
function crc8(words: readonly number[]): number {
  let crc = 0
  for (const word of words) {
    for (let i = 3; i >= 0; i--) {
      crc ^= (word >>> (i * 8)) & 0xff
      for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
    }
  }
  return crc
}

const symbols = (bits: bigint, count: number): string => {
  let out = ''
  for (let i = 0; i < count; i++) {
    out = CODE_ALPHABET[Number(bits & 31n)] + out
    bits >>= 5n
  }
  return out
}

/**
 * The symbols of a code's tail carrying `k` of the genome's later words (words 4 to 3 + k, the last of them not zero)
 * and an 8-bit check over those words: 32k + 8 bits, rounded up to whole symbols with zero bits in front. Every k
 * from 1 to 12 gives a different length, none of them a length a code without a tail has. With a tail, the head's own
 * check is taken over every word of the code instead of its four, so the head cut off alone is refused (but for one
 * chance in 256) rather than read as the look with an older tone.
 */
const tailChars = (k: number): number => Math.ceil((32 * k + 8) / 5)
const TAIL_WORDS = LOOK_WORDS - 4

/** Symbols in groups of `size`, the last group what is left. */
const grouped = (text: string, size = 7): string => text.match(new RegExp(`.{1,${size}}`, 'g'))!.join('-')

/**
 * The look as a short code that parseLookCode reads back exactly; '' for a look outside the wardrobe. The four words'
 * twenty-eight symbols, "XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX", are the whole code of a look whose genome's later words are
 * zero (every look of the older layouts: its code is the code it always had); otherwise a tail follows with those
 * words up to the last that is not zero and a check over all of them, in groups of eight (one word's tail is one
 * group: "-XXXXXXXX").
 */
export function formatLookCode(look: Look): string {
  const genome = packGenome(look)
  const [word, figure, face, wardrobe] = genome
  if (word === LOOK_NONE) return ''
  let k = TAIL_WORDS
  while (k > 0 && genome[3 + k] === 0) k--
  const bits = (BigInt(word) << 104n) | (BigInt(figure) << 72n) | (BigInt(face) << 40n) | (BigInt(wardrobe) << 8n) | BigInt(crc8(genome.slice(0, 4 + k)))
  const head = symbols(bits, CODE_CHARS)
  if (k === 0) return grouped(head)
  let tail = 0n
  for (let i = 0; i < k; i++) tail = (tail << 32n) | BigInt(genome[4 + i])
  tail = (tail << 8n) | BigInt(crc8(genome.slice(4, 4 + k)))
  return `${grouped(head)}-${grouped(symbols(tail, tailChars(k)), 8)}`
}

/** A run of the alphabet's symbols as bits, or null for a symbol outside it. */
const bitsOf = (text: string): bigint | null => {
  let bits = 0n
  for (const ch of text) {
    const v = CODE_ALPHABET.indexOf(ch)
    if (v < 0) return null
    bits = (bits << 5n) | BigInt(v)
  }
  return bits
}

/**
 * The look a code names, or null: twenty-eight symbols of the alphabet (case and dashes or spaces between them
 * ignored), four leading zero bits, a check that matches, and four words that unpack to a look within the wardrobe;
 * or those twenty-eight followed by a tail (formatLookCode) of the genome's later words, its leading bits zero, its
 * last word not zero, its own check over its words and the head's over every word matching; or a twenty-one-symbol code from before the
 * layers, a fifteen-symbol one from before the face, or a legacy eight-symbol one, each checked the same way and
 * upgraded. Anything else is refused.
 */
export function parseLookCode(text: string): Look | null {
  if (typeof text !== 'string') return null
  const clean = text.toUpperCase().replace(/[\s-]/g, '')
  if (clean.length > CODE_CHARS) {
    const k = Array.from({ length: TAIL_WORDS }, (_, i) => i + 1).find((n) => tailChars(n) === clean.length - CODE_CHARS)
    if (k === undefined) return null
    const head = bitsOf(clean.slice(0, CODE_CHARS))
    const tail = bitsOf(clean.slice(CODE_CHARS))
    if (head === null || tail === null || head >> 136n !== 0n || tail >> BigInt(32 * k + 8) !== 0n) return null
    const words = [Number((head >> 104n) & 0xffffffffn), Number((head >> 72n) & 0xffffffffn), Number((head >> 40n) & 0xffffffffn), Number((head >> 8n) & 0xffffffffn)]
    for (let i = k - 1; i >= 0; i--) words.push(Number((tail >> BigInt(8 + 32 * i)) & 0xffffffffn))
    if (words[3 + k] === 0 || crc8(words.slice(4)) !== Number(tail & 0xffn) || crc8(words) !== Number(head & 0xffn)) return null
    return unpackGenome(words)
  }
  if (clean.length !== CODE_CHARS && clean.length !== V3_CODE_CHARS && clean.length !== V2_CODE_CHARS && clean.length !== LEGACY_CODE_CHARS) return null
  const read = bitsOf(clean)
  if (read === null) return null
  const bits = read
  const check = Number(bits & 0xffn)
  if (clean.length === LEGACY_CODE_CHARS) {
    const word = Number(bits >> 8n)
    if (crc8([word]) !== check) return null
    return unpackLegacyLook(word)
  }
  if (clean.length === V2_CODE_CHARS) {
    if (bits >> 72n !== 0n) return null
    const word = Number((bits >> 40n) & 0xffffffffn)
    const figure = Number((bits >> 8n) & 0xffffffffn)
    if (crc8([word, figure]) !== check) return null
    return unpackFigureLook(word, figure)
  }
  if (clean.length === V3_CODE_CHARS) {
    if (bits >> 104n !== 0n) return null
    const word = Number((bits >> 72n) & 0xffffffffn)
    const figure = Number((bits >> 40n) & 0xffffffffn)
    const face = Number((bits >> 8n) & 0xffffffffn)
    if (crc8([word, figure, face]) !== check) return null
    return unpackFaceLook(word, figure, face)
  }
  if (bits >> 136n !== 0n) return null
  const word = Number((bits >> 104n) & 0xffffffffn)
  const figure = Number((bits >> 72n) & 0xffffffffn)
  const face = Number((bits >> 40n) & 0xffffffffn)
  const wardrobe = Number((bits >> 8n) & 0xffffffffn)
  if (crc8([word, figure, face, wardrobe]) !== check) return null
  return unpackLook(word, figure, face, wardrobe)
}

// --- The console's view -----------------------------------------------------------------------------------------

/** One ASCII line per slot ("top        #1f2a44  [1/8]"), then the code; a look outside the wardrobe is one line. */
export function describeLook(look: Look): string[] {
  if (validateLook(look) === null) return ['look: outside the wardrobe']
  const body = look.body as LookBody
  const lines: string[] = []
  for (const slot of LOOK_SLOTS) {
    const options = lookOptions(body, slot, look.layer)
    const i = look[slot]
    let name = options[i].name
    if ((slot === 'bottom' && i === 0 && WARDROBE.outfits[body].matching) || (slot === 'trim' && i === 0)) name = `matching (${hex6(matchingSwatch(look, slot) ?? 0)})`
    lines.push(`${slot.padEnd(11)}${name}  [${i + 1}/${options.length}]`)
  }
  lines.push(`${'code'.padEnd(11)}${formatLookCode(look)}`)
  return lines
}

// --- The console's changes --------------------------------------------------------------------------------------

/**
 * One change to a look, as the console's `look` command asks it (terminal/bridge.ts LookBridge): a slot set to an
 * option (its 1-based number as describeLook prints it, or its name), a preset by name, a build by name (LOOK_BUILDS:
 * its four body sliders), a look code, a look drawn from a seed, or the seed's own look again.
 */
export type LookChange =
  | { readonly kind: 'slot'; readonly slot: string; readonly value: string }
  | { readonly kind: 'preset'; readonly name: string }
  | { readonly kind: 'build'; readonly name: string }
  | { readonly kind: 'face'; readonly name: string }
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'random'; readonly seed: number }
  | { readonly kind: 'reset' }

/** What a change gives: the look after it, or why it was refused (never a look outside the wardrobe). */
export type LookChangeResult = { readonly look: Look; readonly error: null } | { readonly look: null; readonly error: string }

const refused = (error: string): LookChangeResult => ({ look: null, error })
const changed = (look: Look | null, error: string): LookChangeResult => (look === null ? refused(error) : { look, error: null })

/**
 * The look after `change`, or the reason it was refused. `seed` is the look `reset` returns to (lookFromSeed: the
 * visitor's own seed, or an agent's index). A slot's value is its 1-based number or an option's name, case
 * ignored (a height may also be metres, "1.80" or "1.80 m"); a body change keeps what still fits (withLookSlot).
 * Pure and deterministic: `random` takes its seed.
 */
export function changeLook(look: Look, change: LookChange, seed: number): LookChangeResult {
  if (validateLook(look) === null) return refused('the look worn now is outside the wardrobe')
  switch (change.kind) {
    case 'reset': return changed(lookFromSeed(seed), 'no look for that seed')
    case 'random': return Number.isFinite(change.seed) ? changed(lookFromSeed(change.seed), 'no look for that seed') : refused('the seed must be a number')
    case 'code': return changed(parseLookCode(change.code), `not a look code: '${change.code}' (twenty-eight symbols, XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX, and a tail when the look has one)`)
    case 'build': {
      const next = withBuild(look, change.name)
      return next ? { look: next, error: null } : refused(`no build named '${change.name}': ${LOOK_BUILDS.map((b) => b.name).join(', ')}`)
    }
    case 'face': {
      const next = withFaceShape(look, change.name)
      return next ? { look: next, error: null } : refused(`no face shape named '${change.name}': ${LOOK_FACE_SHAPES.map((f) => f.name).join(', ')}`)
    }
    case 'preset': {
      const p = lookPreset(change.name)
      return p ? { look: p.look, error: null } : refused(`no preset named '${change.name}': ${LOOK_PRESETS.map((x) => x.name).join(', ')}`)
    }
    case 'slot': {
      const want = change.slot.toLowerCase()
      const slot = LOOK_SLOTS.find((s) => s.toLowerCase() === want)
      if (!slot) return refused(`no slot named '${change.slot}': ${LOOK_SLOTS.join(', ')}`)
      const options = lookOptions(look.body as LookBody, slot, look.layer)
      const text = change.value.trim()
      let index: number
      if (/^\d{1,3}$/.test(text)) {
        index = Number(text) - 1
        if (index < 0 || index >= options.length) return refused(`${slot} has ${options.length} options (1-${options.length})`)
      } else if (slot === 'height' && /^\d\.\d{1,2}\s*m?$/i.test(text)) {
        index = statureStep(Number(text.replace(/\s*m$/i, '')))
      } else {
        index = options.findIndex((o) => o.name.toLowerCase() === text.toLowerCase())
        if (index < 0) return refused(`no ${slot} named '${text}': ${isSlider(slot) || isFaceSlider(slot) || slot === 'age' ? `1-${options.length}` : options.map((o) => o.name).join(', ')}`)
      }
      return changed(withLookSlot(look, slot, index), `${slot} ${index + 1} is outside the wardrobe`)
    }
  }
}
