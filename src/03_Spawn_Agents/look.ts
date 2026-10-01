/**
 * Why does this file exist? It is what a person may look like: a body, an outfit and its colours chosen from the
 * city's own business-casual wardrobe, packed into one word the crowd shader reads. The wardrobe is closed by
 * construction: every slot is an index into the four bodies crowd.ts draws, the optional pieces it carries (a tie,
 * a bag, a cup, long hair, glasses) and the colour palettes it already paints people with, so no stored value, no
 * typed command and no shared code can dress anyone in anything the crowd does not wear today. The same module
 * reproduces the choice the shader's hash makes for an agent (lookFromSeed), so a returning visitor's look and an
 * agent's hashed look are the same kind of record; a short code with a checksum lets a look be written down and
 * shared; describeLook is the console's view of it. Pure: no DOM, no GPU, no clock, no randomness.
 * What breaks if it is removed? The customizer would have no catalogue, nothing could be saved or shared, and the
 * crowd's per-agent attribute would have no agreed bit layout to carry.
 */

/** The four bodies crowd.ts draws, in draw-list order (an agent's hashed body is its index modulo four). */
export const LOOK_BODIES = ['suit', 'smart casual', 'pantsuit', 'skirt suit'] as const
export type LookBody = 0 | 1 | 2 | 3

/** The bit each optional piece has in the crowd's per-person mask (crowd.ts `O`); bit 0 is "no option". */
export const LOOK_PIECE_BIT = Object.freeze({ tie: 1, bag: 2, cup: 3, longHair: 4, glasses: 5 })

/**
 * The crowd's colour palettes, verbatim (crowd.ts `PALETTE`, pinned by look.test.ts against the source). Every
 * cloth is a business-casual one: suits, blazers, chinos, shirts, blouses, skirts, office shoes, a bag's leather.
 */
export const LOOK_PALETTE = Object.freeze({
  skin: Object.freeze([0xf3d2b8, 0xe8b894, 0xd29f79, 0xb97f5a, 0x9a6444, 0x7a4a31, 0x5c3522, 0xe5c0a0]),
  hair: Object.freeze([0x1b1512, 0x2a1d14, 0x3b2618, 0x5e3c24, 0x7a3a1f, 0xb8935a, 0x8a6a48, 0x9c9a96]),
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

/** The grey the shader mixes hair to for one person in ten (crowd.ts `vec3(0.6, 0.6, 0.58)`), the ninth hair colour. */
export const GREY_HAIR = 0x999994

/**
 * The slots of a look, in the order the console lists them. Every slot is an index into a list of options; the
 * list may depend on the body (an outfit's cloths differ per body) and is given by lookOptions().
 */
export const LOOK_SLOTS = [
  'body', 'height', 'build', 'skin', 'hairStyle', 'hairColour', 'top', 'bottom', 'shirt', 'shoes', 'tie', 'eyewear', 'bag', 'cup',
] as const
export type LookSlot = (typeof LOOK_SLOTS)[number]
export type Look = Readonly<Record<LookSlot, number>>

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

/**
 * The catalogue: what each slot may hold. `steps` is the count of height and build steps (3 bits each in the
 * word); `outfits` is per body, mirroring crowd.ts's four fragment branches: the suit's trousers match the jacket
 * (the hashed crowd) or take another suit cloth; the pantsuit's match the blazer or are dark trousers; the skirt
 * suit's skirt and the smart-casual chinos have palettes of their own.
 */
export const WARDROBE = Object.freeze({
  bodies: LOOK_BODIES,
  steps: 8,
  hairStyle: Object.freeze(['short', 'long']),
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
 * Where each slot lives in the packed word: [first bit, width]. Bit 0 says the word is a look at all (LOOK_NONE
 * is "as hashed"); the five pieces sit at bit 2 + their crowd bit, so `(word >> 2) & 62` is the mask the crowd's
 * agentXform tests with `(mask >> opt) & 1`. Every width is pinned to hold its slot's largest option count.
 */
export const LOOK_FIELD: Readonly<Record<LookSlot, readonly [shift: number, width: number]>> = Object.freeze({
  body: [1, 2],
  tie: [2 + LOOK_PIECE_BIT.tie, 1],
  bag: [2 + LOOK_PIECE_BIT.bag, 1],
  cup: [2 + LOOK_PIECE_BIT.cup, 1],
  hairStyle: [2 + LOOK_PIECE_BIT.longHair, 1],
  eyewear: [2 + LOOK_PIECE_BIT.glasses, 1],
  skin: [8, 3],
  hairColour: [11, 4],
  top: [15, 3],
  bottom: [18, 3],
  shirt: [21, 3],
  shoes: [24, 2],
  height: [26, 3],
  build: [29, 3],
})

/** The word that means "dressed as the hash dresses everyone": bit 0 clear. */
export const LOOK_NONE = 0

/**
 * The proportions the crowd shader derives from a height or build step: scale = base + step / (steps - 1) * range,
 * the same span the hash gives (crowd.ts: a woman's height h*0.1+0.92, a man's h*0.14+0.94, width h*0.14+0.94).
 */
export const LOOK_SCALE = Object.freeze({
  heightMan: Object.freeze({ base: 0.94, range: 0.14 }),
  heightWoman: Object.freeze({ base: 0.92, range: 0.1 }),
  build: Object.freeze({ base: 0.94, range: 0.14 }),
})

const isBody = (v: unknown): v is LookBody => v === 0 || v === 1 || v === 2 || v === 3
const womanBody = (body: LookBody): boolean => body >= 2
const hex6 = (n: number) => `#${n.toString(16).padStart(6, '0')}`
const swatches = (list: readonly number[]): LookOption[] => list.map((hex) => ({ name: hex6(hex), hex }))
const named = (names: readonly string[]): LookOption[] => names.map((name) => ({ name, hex: null }))
const steps = (): LookOption[] => Array.from({ length: WARDROBE.steps }, (_, i) => ({ name: `${i + 1}`, hex: null }))

/** The options a slot may hold for a body, in index order. */
export function lookOptions(body: LookBody, slot: LookSlot): readonly LookOption[] {
  const outfit = WARDROBE.outfits[body]
  switch (slot) {
    case 'body': return named(LOOK_BODIES)
    case 'height': case 'build': return steps()
    case 'skin': return swatches(LOOK_PALETTE.skin)
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

/** The height multiplier the crowd shader applies for a look (a woman's body spans a narrower range). */
export function heightScale(look: Look): number {
  const s = womanBody(look.body as LookBody) ? LOOK_SCALE.heightWoman : LOOK_SCALE.heightMan
  return s.base + (look.height / (WARDROBE.steps - 1)) * s.range
}

/** The width multiplier the crowd shader applies for a look. */
export function buildScale(look: Look): number {
  return LOOK_SCALE.build.base + (look.build / (WARDROBE.steps - 1)) * LOOK_SCALE.build.range
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/**
 * The look a value is, or null: an object with exactly the slots, every one an integer within its options for
 * the body named. Nothing else is accepted (not a string, an array, a float, a negative, an extra key), so a
 * stored or typed record can only ever name what the crowd wears.
 */
export function validateLook(raw: unknown): Look | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (Object.keys(r).length !== LOOK_SLOTS.length) return null
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

/** The one u32 the crowd's per-agent attribute carries; bit 0 set. Only a valid look packs (else LOOK_NONE). */
export function packLook(look: Look): number {
  if (validateLook(look) === null) return LOOK_NONE
  let word = 1
  for (const slot of LOOK_SLOTS) {
    const [shift] = LOOK_FIELD[slot]
    word |= look[slot] << shift
  }
  return word >>> 0
}

/** The look a word carries, or null for LOOK_NONE and for any word whose fields are outside the catalogue. */
export function unpackLook(word: number): Look | null {
  if (!Number.isInteger(word) || word < 0 || word > 0xffffffff || (word & 1) === 0) return null
  const out: Record<string, number> = {}
  for (const slot of LOOK_SLOTS) {
    const [shift, width] = LOOK_FIELD[slot]
    out[slot] = (word >>> shift) & ((1 << width) - 1)
  }
  return validateLook(out)
}

/** The crowd's per-person piece mask for a packed word (tie at bit 1 … glasses at bit 5), 0 for LOOK_NONE. */
export const lookMask = (word: number): number => (word & 1) === 0 ? 0 : (word >>> 2) & 62

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

/** The crowd's two hash chains for an agent: the vertex stage's (pieces, proportions) and the fragment's (colours). */
export const LOOK_HASH = Object.freeze({ pieces: 13.37, colours: 7.919 })
/** The thresholds a piece is drawn above (crowd.ts `step(edge, h(k))`); a woman's bag is commoner than a man's. */
export const LOOK_ODDS = Object.freeze({ tie: 0.3, bagMan: 0.7, bagWoman: 0.62, cup: 0.82, longHair: 0.35, glasses: 0.78, grey: 0.9, darkTrousers: 0.6 })

const pickIndex = (h: number, length: number): number => Math.min(u32(f32(h * f32(length - 0.001))), length - 1)
const above = (h: number, edge: number): number => (h >= f32(edge) ? 1 : 0)
const stepOf = (h: number): number => Math.min(WARDROBE.steps - 1, Math.round(h * (WARDROBE.steps - 1)))

/**
 * The look the crowd's hash gives an agent of this index (any non-negative integer; a profile seed does as well):
 * body = index mod 4, pieces from the vertex chain, colours from the fragment chain, exactly as crowd.ts chooses
 * them today, with the continuous height and width rounded to the nearest step. What the word cannot carry (the
 * tie's cloth, the bag's leather, the skirt suit's hose) stays hashed in the shader, so it is not here.
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
  const look: Record<LookSlot, number> = {
    body,
    height: stepOf(hp(6)),
    build: stepOf(hp(7)),
    skin: pickIndex(hc(1), LOOK_PALETTE.skin.length),
    hairStyle: above(hp(4), LOOK_ODDS.longHair),
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
  preset('navy suit', { body: 0, height: 4, build: 3, skin: 1, hairStyle: 0, hairColour: 1, top: 0, bottom: 0, shirt: 0, shoes: 0, tie: 1, eyewear: 0, bag: 0, cup: 0 }),
  preset('charcoal suit', { body: 0, height: 5, build: 4, skin: 4, hairStyle: 0, hairColour: 0, top: 1, bottom: 0, shirt: 1, shoes: 1, tie: 1, eyewear: 1, bag: 1, cup: 0 }),
  preset('camel blazer', { body: 1, height: 3, build: 3, skin: 2, hairStyle: 0, hairColour: 3, top: 0, bottom: 2, shirt: 0, shoes: 1, tie: 0, eyewear: 0, bag: 0, cup: 1 }),
  preset('navy blazer', { body: 1, height: 4, build: 5, skin: 6, hairStyle: 0, hairColour: 0, top: 1, bottom: 0, shirt: 2, shoes: 0, tie: 0, eyewear: 1, bag: 0, cup: 0 }),
  preset('burgundy pantsuit', { body: 2, height: 3, build: 3, skin: 3, hairStyle: 1, hairColour: 2, top: 2, bottom: 0, shirt: 0, shoes: 0, tie: 0, eyewear: 0, bag: 1, cup: 0 }),
  preset('cream pantsuit', { body: 2, height: 5, build: 2, skin: 5, hairStyle: 0, hairColour: 8, top: 3, bottom: 1, shirt: 2, shoes: 2, tie: 0, eyewear: 1, bag: 0, cup: 1 }),
  preset('navy skirt suit', { body: 3, height: 4, build: 3, skin: 0, hairStyle: 1, hairColour: 5, top: 1, bottom: 0, shirt: 0, shoes: 0, tie: 0, eyewear: 1, bag: 1, cup: 0 }),
  preset('camel skirt suit', { body: 3, height: 2, build: 4, skin: 7, hairStyle: 1, hairColour: 6, top: 4, bottom: 2, shirt: 1, shoes: 1, tie: 0, eyewear: 0, bag: 0, cup: 0 }),
])

/** The preset of that name (case and surrounding space ignored), or null. */
export function lookPreset(name: string): LookPreset | null {
  const key = name.trim().toLowerCase()
  return LOOK_PRESETS.find((p) => p.name === key) ?? null
}

// --- The look code ----------------------------------------------------------------------------------------------

/** 32 symbols without I, L, O and U, so a code read aloud or copied by hand is not mistaken. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_CHARS = 8 // 40 bits: the 32-bit word, then an 8-bit check

/** CRC-8 (polynomial 0x07) over the word's four bytes: any single mistyped symbol (a burst of five bits) is caught. */
function crc8(word: number): number {
  let crc = 0
  for (let i = 3; i >= 0; i--) {
    crc ^= (word >>> (i * 8)) & 0xff
    for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
  }
  return crc
}

/** The look as a short code, "XXXX-XXXX", that parseLookCode reads back exactly; '' for a look outside the wardrobe. */
export function formatLookCode(look: Look): string {
  const word = packLook(look)
  if (word === LOOK_NONE) return ''
  let bits = (BigInt(word) << 8n) | BigInt(crc8(word))
  let out = ''
  for (let i = 0; i < CODE_CHARS; i++) {
    out = CODE_ALPHABET[Number(bits & 31n)] + out
    bits >>= 5n
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

/**
 * The look a code names, or null: eight symbols of the alphabet (case and a dash or spaces between them ignored),
 * a check that matches, and a word that unpacks to a look within the wardrobe. Anything else is refused.
 */
export function parseLookCode(text: string): Look | null {
  if (typeof text !== 'string') return null
  const clean = text.toUpperCase().replace(/[\s-]/g, '')
  if (clean.length !== CODE_CHARS) return null
  let bits = 0n
  for (const ch of clean) {
    const v = CODE_ALPHABET.indexOf(ch)
    if (v < 0) return null
    bits = (bits << 5n) | BigInt(v)
  }
  const word = Number(bits >> 8n)
  const check = Number(bits & 0xffn)
  if (crc8(word) !== check) return null
  return unpackLook(word)
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
