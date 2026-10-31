// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is what a person may look like: a body, its figure (the eight body sliders of
 * humanoid.ts: stature, mass, muscle, shoulders, hips, legs, posture, head), its face (the seven face sliders: brow,
 * jaw, chin, cheek, nose, eyes, lips; an age; a skin undertone; a hair style), an outfit and its colours chosen from
 * the city's own business-casual wardrobe, packed into the three words the crowd shader reads (the look word, the
 * figure word and the face word). The wardrobe is closed by construction: every slot is an index into the four bodies
 * crowd.ts draws, the optional pieces it carries (a tie, a bag, a cup, the hair in its styles, glasses, the face
 * itself), the colour palettes it already paints people with and the steps of each slider, so no stored value, no
 * typed command and no shared code can dress anyone in anything the crowd does not wear today. The same module
 * reproduces the choice the shader's hash makes for an agent (lookFromSeed), so a returning visitor's look and an
 * agent's hashed look are the same kind of record; a short code with a checksum lets a look be written down and
 * shared; describeLook is the console's view of it. A look kept before the face existed (twenty slots, a
 * fifteen-symbol code) or before the figure (fourteen slots, an eight-symbol code) is upgraded on the way in: the
 * face to the base face, a height and build to a stature and a mass. Pure: no DOM, no GPU, no clock, no randomness.
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
export const LOOK_PIECE_BIT = Object.freeze({ tie: 1, bag: 2, cup: 3, longHair: 4, glasses: 5, hairCap: 6, bob: 7, bun: 8, face: 9 })

/**
 * The crowd's colour palettes, verbatim (crowd.ts `PALETTE`, pinned by look.test.ts against the source). Every
 * cloth is a business-casual one: suits, blazers, chinos, shirts, blouses, skirts, office shoes, a bag's leather.
 */
export const LOOK_PALETTE = Object.freeze({
  skin: Object.freeze([0xf3d2b8, 0xe8b894, 0xd29f79, 0xb97f5a, 0x9a6444, 0x7a4a31, 0x5c3522, 0xe5c0a0]),
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
  'skin', 'age', 'undertone', 'hairStyle', 'hairColour', 'top', 'bottom', 'shirt', 'shoes', 'tie', 'eyewear', 'bag', 'cup',
] as const
export type LookSlot = (typeof LOOK_SLOTS)[number]
export type Look = Readonly<Record<LookSlot, number>>

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

/** The hair styles' indices (WARDROBE.hairStyle): the two the look had before the face keep their numbers. */
export const HAIR = Object.freeze({ short: 0, long: 1, bob: 2, bun: 3, bald: 4 })

/**
 * The catalogue: what each slot may hold. `stature` is the height slider (32 steps, 1.50 m to 2.05 m: five bits);
 * `sliderSteps` the other body sliders' and the face sliders' (four bits each) but the head's (`headSteps`, three
 * bits); `ageSteps` the age's (three bits); `undertone` the skin's cast; `outfits` is per body, mirroring crowd.ts's
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
  hairStyle: Object.freeze(['short', 'long', 'bob', 'bun', 'bald']),
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
 * three; bit 31 is spare. Every width is pinned to hold its slot's largest option count.
 */
export const LOOK_FIELD: Readonly<Record<LookSlot, readonly [word: 0 | 1 | 2, shift: number, width: number]>> = Object.freeze({
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
})

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
/** The links of the fragment chain (LOOK_HASH.colours) the age, the undertone and the iris colour are drawn from. */
export const LOOK_HASHED_COLOUR = Object.freeze({ age: 7, undertone: 8, iris: 13 })

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
const stature = (): LookOption[] => Array.from({ length: WARDROBE.stature.steps }, (_, i) => ({ name: `${statureOf(i).toFixed(2)} m`, hex: null }))

/** The options a slot may hold for a body, in index order. */
export function lookOptions(body: LookBody, slot: LookSlot): readonly LookOption[] {
  const outfit = WARDROBE.outfits[body]
  switch (slot) {
    case 'body': return named(LOOK_BODIES)
    case 'height': return stature()
    case 'mass': case 'muscle': case 'shoulders': case 'hips': case 'legs': case 'posture': return steps(WARDROBE.sliderSteps)
    case 'head': return steps(WARDROBE.headSteps)
    case 'brow': case 'jaw': case 'chin': case 'cheek': case 'nose': case 'eyes': case 'lips': return steps(WARDROBE.sliderSteps)
    case 'skin': return swatches(LOOK_PALETTE.skin)
    case 'age': return steps(WARDROBE.ageSteps)
    case 'undertone': return named(WARDROBE.undertone)
    case 'hairStyle': return named(WARDROBE.hairStyle)
    case 'hairColour': return [...swatches(LOOK_PALETTE.hair), { name: 'grey', hex: GREY_HAIR }]
    case 'top': return swatches(LOOK_PALETTE[outfit.top])
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

/** The swatch a colour slot shows (the top's cloth when the trousers match it), or null for a slot without one. */
export function lookSwatch(look: Look, slot: LookSlot): number | null {
  const body = look.body as LookBody
  const hex = lookOptions(body, slot)[look[slot]]?.hex ?? null
  if (hex === null && slot === 'bottom' && look.bottom === 0 && WARDROBE.outfits[body].matching) return lookSwatch(look, 'top')
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
  return validateLook(out)
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

/**
 * The look a value is, or null: an object with exactly the slots, every one an integer within its options for
 * the body named; or a twenty-slot look from before the face (upgradeFigureLook); or a legacy fourteen-slot look
 * (upgradeLegacyLook). Nothing else is accepted (not a string, an array, a float, a negative, an extra key), so a
 * stored or typed record can only ever name what the crowd wears.
 */
export function validateLook(raw: unknown): Look | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const keys = Object.keys(r).length
  if (keys === LEGACY_LOOK_SLOTS.length && hasOwn(r, 'build')) return upgradeLegacyLook(r)
  if (keys === LOOK_V2_SLOTS.length && !hasOwn(r, 'brow')) return upgradeFigureLook(r)
  if (keys !== LOOK_SLOTS.length) return null
  if (!isBody(r.body)) return null
  const body = r.body
  const out: Record<string, number> = {}
  for (const slot of LOOK_SLOTS) {
    if (!hasOwn(r, slot)) return null
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

const packWord = (look: Look, word: 0 | 1 | 2): number => {
  let out = word === 0 ? 1 : 0
  for (const slot of LOOK_SLOTS) {
    const [w, shift] = LOOK_FIELD[slot]
    if (w === word) out |= look[slot] << shift
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

const isWord = (word: number): boolean => Number.isInteger(word) && word >= 0 && word <= 0xffffffff

/**
 * The look three words carry, or null for LOOK_NONE, for any triple whose fields are outside the catalogue, and for a
 * look word whose long-hair bit disagrees with the face word's style (a forged pair: the shader would draw one and
 * the console report the other).
 */
export function unpackLook(word: number, figure: number, face: number): Look | null {
  if (!isWord(word) || !isWord(figure) || !isWord(face) || (word & 1) === 0) return null
  const out: Record<string, number> = {}
  for (const slot of LOOK_SLOTS) {
    const [w, shift, width] = LOOK_FIELD[slot]
    out[slot] = ((w === 0 ? word : w === 1 ? figure : face) >>> shift) & ((1 << width) - 1)
  }
  const look = validateLook(out)
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

/** The hair pieces a style wears, as mask bits: long hair 16, the cap 64 (every style but bald), a bob 128, a bun 256. */
export const hairBits = (style: number): number =>
  (style === HAIR.long ? 1 << LOOK_PIECE_BIT.longHair : 0) | (style === HAIR.bald ? 0 : 1 << LOOK_PIECE_BIT.hairCap) |
  (style === HAIR.bob ? 1 << LOOK_PIECE_BIT.bob : 0) | (style === HAIR.bun ? 1 << LOOK_PIECE_BIT.bun : 0)

/**
 * The crowd's per-person piece mask for a packed look word and face word, as the eye pass tests it (tie at bit 1 …
 * glasses at bit 5 from the look word; the hair bits from the face word's style; the face bit 9 always), 0 for
 * LOOK_NONE. The shadow pass's mask is this without bit 9.
 */
export const lookMask = (word: number, face: number): number =>
  (word & 1) === 0 ? 0 : (((word >>> 2) & 46) | hairBits((face >>> LOOK_FIELD.hairStyle[1]) & 7) | (1 << LOOK_PIECE_BIT.face)) >>> 0

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
 * long, under `bun` a bob, else a bun; a man's split link at or above `bald` is bald, else long.
 */
export const LOOK_ODDS = Object.freeze({ tie: 0.3, bagMan: 0.7, bagWoman: 0.62, cup: 0.82, longHair: 0.35, glasses: 0.78, grey: 0.9, darkTrousers: 0.6, bob: 0.34, bun: 0.67, bald: 0.96 })

const pickIndex = (h: number, length: number): number => Math.min(u32(f32(h * f32(length - 0.001))), length - 1)
const above = (h: number, edge: number): number => (h >= f32(edge) ? 1 : 0)
/** A hashed step: round(h × n), as the shader does it (floor(h × n + 0.5)). */
const stepOf = (h: number, n: number): number => Math.min(n, Math.round(h * n))

/**
 * The look the crowd's hash gives an agent of this index (any non-negative integer; a profile seed does as well):
 * body = index mod 4, pieces, the figure and the face from the vertex chain, colours, the age and the undertone from
 * the fragment chain, exactly as crowd.ts chooses them, each slider rounded to its step. What the words cannot carry
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
    skin: pickIndex(hc(1), LOOK_PALETTE.skin.length),
    age: stepOf(hc(LOOK_HASHED_COLOUR.age), WARDROBE.ageSteps - 1),
    undertone: pickIndex(hc(LOOK_HASHED_COLOUR.undertone), WARDROBE.undertone.length),
    hairStyle,
    hairColour: grey ? LOOK_PALETTE.hair.length : pickIndex(hc(2), LOOK_PALETTE.hair.length),
    top: pickIndex(hc(3), LOOK_PALETTE[outfit.top].length),
    bottom,
    shirt: pickIndex(hc(5), LOOK_PALETTE[outfit.shirt].length),
    shoes: pickIndex(hc(6), LOOK_PALETTE[outfit.shoes].length),
    tie: above(hp(1), LOOK_ODDS.tie),
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

const preset = (name: string, look: Record<LookSlot, number>): LookPreset => {
  const valid = validateLook(look)
  if (valid === null) throw new Error(`look preset "${name}" is outside the wardrobe`)
  return Object.freeze({ name, look: valid })
}

/** A handful of named outfits per body for the picker; every one validates, and every cloth is the crowd's. */
export const LOOK_PRESETS: readonly LookPreset[] = Object.freeze([
  preset('navy suit', { body: 0, height: 16, mass: 7, muscle: 8, shoulders: 8, hips: 7, legs: 8, posture: 9, head: 4, brow: 8, jaw: 9, chin: 8, cheek: 7, nose: 8, eyes: 8, lips: 7, skin: 1, age: 3, undertone: 1, hairStyle: 0, hairColour: 1, top: 0, bottom: 0, shirt: 0, shoes: 0, tie: 1, eyewear: 0, bag: 0, cup: 0 }),
  preset('charcoal suit', { body: 0, height: 20, mass: 9, muscle: 7, shoulders: 10, hips: 7, legs: 7, posture: 7, head: 4, brow: 9, jaw: 11, chin: 10, cheek: 8, nose: 9, eyes: 7, lips: 6, skin: 4, age: 5, undertone: 0, hairStyle: 0, hairColour: 0, top: 1, bottom: 0, shirt: 1, shoes: 1, tie: 1, eyewear: 1, bag: 1, cup: 0 }),
  preset('camel blazer', { body: 1, height: 13, mass: 7, muscle: 6, shoulders: 7, hips: 8, legs: 9, posture: 8, head: 4, brow: 7, jaw: 7, chin: 7, cheek: 9, nose: 7, eyes: 9, lips: 9, skin: 2, age: 2, undertone: 3, hairStyle: 0, hairColour: 3, top: 0, bottom: 2, shirt: 0, shoes: 1, tie: 0, eyewear: 0, bag: 0, cup: 1 }),
  preset('navy blazer', { body: 1, height: 17, mass: 11, muscle: 10, shoulders: 9, hips: 9, legs: 8, posture: 10, head: 3, brow: 8, jaw: 10, chin: 9, cheek: 8, nose: 10, eyes: 8, lips: 8, skin: 6, age: 4, undertone: 1, hairStyle: 4, hairColour: 0, top: 1, bottom: 0, shirt: 2, shoes: 0, tie: 0, eyewear: 1, bag: 0, cup: 0 }),
  preset('burgundy pantsuit', { body: 2, height: 11, mass: 7, muscle: 7, shoulders: 6, hips: 9, legs: 8, posture: 9, head: 4, brow: 7, jaw: 6, chin: 7, cheek: 10, nose: 7, eyes: 9, lips: 10, skin: 3, age: 2, undertone: 2, hairStyle: 1, hairColour: 2, top: 2, bottom: 0, shirt: 0, shoes: 0, tie: 0, eyewear: 0, bag: 1, cup: 0 }),
  preset('cream pantsuit', { body: 2, height: 16, mass: 5, muscle: 8, shoulders: 7, hips: 7, legs: 10, posture: 11, head: 4, brow: 8, jaw: 7, chin: 8, cheek: 9, nose: 8, eyes: 8, lips: 9, skin: 5, age: 6, undertone: 0, hairStyle: 3, hairColour: 8, top: 3, bottom: 1, shirt: 2, shoes: 2, tie: 0, eyewear: 1, bag: 0, cup: 1 }),
  preset('navy skirt suit', { body: 3, height: 13, mass: 7, muscle: 6, shoulders: 6, hips: 10, legs: 8, posture: 8, head: 4, brow: 6, jaw: 7, chin: 6, cheek: 8, nose: 6, eyes: 10, lips: 9, skin: 0, age: 3, undertone: 2, hairStyle: 2, hairColour: 5, top: 1, bottom: 0, shirt: 0, shoes: 0, tie: 0, eyewear: 1, bag: 1, cup: 0 }),
  preset('camel skirt suit', { body: 3, height: 9, mass: 9, muscle: 5, shoulders: 7, hips: 11, legs: 7, posture: 6, head: 5, brow: 9, jaw: 8, chin: 9, cheek: 11, nose: 9, eyes: 7, lips: 11, skin: 7, age: 4, undertone: 3, hairStyle: 1, hairColour: 6, top: 4, bottom: 2, shirt: 1, shoes: 1, tie: 0, eyewear: 0, bag: 0, cup: 0 }),
])

/** The preset of that name (case and surrounding space ignored), or null. */
export function lookPreset(name: string): LookPreset | null {
  const key = name.trim().toLowerCase()
  return LOOK_PRESETS.find((p) => p.name === key) ?? null
}

// --- The look code ----------------------------------------------------------------------------------------------

/** 32 symbols without I, L, O and U, so a code read aloud or copied by hand is not mistaken. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** 105 bits: one zero bit, the look word, the figure word, the face word, then an 8-bit check over the three. */
const CODE_CHARS = 21
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

/** The look as a short code, "XXXXXXX-XXXXXXX-XXXXXXX", that parseLookCode reads back exactly; '' for a look outside the wardrobe. */
export function formatLookCode(look: Look): string {
  const word = packLook(look)
  if (word === LOOK_NONE) return ''
  const figure = packFigure(look)
  const face = packFace(look)
  const bits = (BigInt(word) << 72n) | (BigInt(figure) << 40n) | (BigInt(face) << 8n) | BigInt(crc8([word, figure, face]))
  const out = symbols(bits, CODE_CHARS)
  return `${out.slice(0, 7)}-${out.slice(7, 14)}-${out.slice(14)}`
}

/**
 * The look a code names, or null: twenty-one symbols of the alphabet (case and dashes or spaces between them
 * ignored), one leading zero bit, a check that matches, and three words that unpack to a look within the wardrobe;
 * or a fifteen-symbol code from before the face, or a legacy eight-symbol one, each checked the same way and
 * upgraded. Anything else is refused.
 */
export function parseLookCode(text: string): Look | null {
  if (typeof text !== 'string') return null
  const clean = text.toUpperCase().replace(/[\s-]/g, '')
  if (clean.length !== CODE_CHARS && clean.length !== V2_CODE_CHARS && clean.length !== LEGACY_CODE_CHARS) return null
  let bits = 0n
  for (const ch of clean) {
    const v = CODE_ALPHABET.indexOf(ch)
    if (v < 0) return null
    bits = (bits << 5n) | BigInt(v)
  }
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
  if (bits >> 104n !== 0n) return null
  const word = Number((bits >> 72n) & 0xffffffffn)
  const figure = Number((bits >> 40n) & 0xffffffffn)
  const face = Number((bits >> 8n) & 0xffffffffn)
  if (crc8([word, figure, face]) !== check) return null
  return unpackLook(word, figure, face)
}

// --- The console's view -----------------------------------------------------------------------------------------

/** One ASCII line per slot ("top        #1f2a44  [1/8]"), then the code; a look outside the wardrobe is one line. */
export function describeLook(look: Look): string[] {
  if (validateLook(look) === null) return ['look: outside the wardrobe']
  const body = look.body as LookBody
  const lines: string[] = []
  for (const slot of LOOK_SLOTS) {
    const options = lookOptions(body, slot)
    const i = look[slot]
    let name = options[i].name
    if (slot === 'bottom' && i === 0 && WARDROBE.outfits[body].matching) name = `matching (${hex6(lookSwatch(look, 'top') ?? 0)})`
    lines.push(`${slot.padEnd(11)}${name}  [${i + 1}/${options.length}]`)
  }
  lines.push(`${'code'.padEnd(11)}${formatLookCode(look)}`)
  return lines
}

// --- The console's changes --------------------------------------------------------------------------------------

/**
 * One change to a look, as the console's `look` command asks it (terminal/bridge.ts LookBridge): a slot set to an
 * option (its 1-based number as describeLook prints it, or its name), a preset by name, a look code, a look drawn
 * from a seed, or the seed's own look again.
 */
export type LookChange =
  | { readonly kind: 'slot'; readonly slot: string; readonly value: string }
  | { readonly kind: 'preset'; readonly name: string }
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
    case 'code': return changed(parseLookCode(change.code), `not a look code: '${change.code}' (twenty-one symbols, XXXXXXX-XXXXXXX-XXXXXXX)`)
    case 'preset': {
      const p = lookPreset(change.name)
      return p ? { look: p.look, error: null } : refused(`no preset named '${change.name}': ${LOOK_PRESETS.map((x) => x.name).join(', ')}`)
    }
    case 'slot': {
      const want = change.slot.toLowerCase()
      const slot = LOOK_SLOTS.find((s) => s.toLowerCase() === want)
      if (!slot) return refused(`no slot named '${change.slot}': ${LOOK_SLOTS.join(', ')}`)
      const options = lookOptions(look.body as LookBody, slot)
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
