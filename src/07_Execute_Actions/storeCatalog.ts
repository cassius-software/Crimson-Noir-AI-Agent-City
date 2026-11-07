// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is what the five storefronts (01_Initialize_World/storefronts.ts) sell and the rule a
 * purchase passes: every catalogue line with its stable id, its shop, the operator level it asks and its price in
 * civic credits, the bit it owns in the progression record's unlock spaces (look, property, furniture: the
 * progression engine's purchase gate, docs/progression.md), and what it does when worn (the look slots it sets,
 * through look.ts withLookSlot, so nothing a shop sells can dress anyone in anything the crowd does not wear); and a
 * gate over plain bits for the practice purse, which takes the price and sets the bit only when the level is reached,
 * the credits are there and the line is not owned yet.
 *
 * A line whose look slots the wardrobe does not have yet (tattoos, prosthetic limbs, watches: the customizer's coming
 * slots) is on order: shown, priced, never sold, and live the moment the wardrobe gains a slot of that name. The
 * design house's furniture and the property deeds are on order the same way until the properties open.
 *
 * The level, the credits and what is owned are not kept here: a purse answers for them (shopkeeper.ts). The
 * progression engine's keeper is the real one; until it lands the shops run on a practice purse
 * (05_Observe_Environment/shopStore.ts), and the card says so.
 * What breaks if it is removed? The shops have nothing to sell and nothing decides whether a purchase may happen.
 */
import { LOOK_SLOTS, withLookSlot, type Look, type LookSlot } from '../03_Spawn_Agents/look.ts'
import type { ShopKind } from '../01_Initialize_World/storefronts.ts'

/** The highest operator level. */
export const MAX_LEVEL = 20

/**
 * The progression record's unlock spaces and their sizes (progression.ts UNLOCK_SPACE): an item's bit is an index in
 * one of them, and keeps its meaning for ever once shipped.
 */
export const SPACE_SIZE = Object.freeze({ look: 1024, property: 64, furniture: 512 })
export type Space = keyof typeof SPACE_SIZE
/**
 * Where the shops number their lines in each space (agreed with the progression and customizer threads): worn lines
 * at look 512 + their catalogue id (look 512..767 is the shops'; the wardrobe's own unlocks keep the rest), the
 * design house's furniture from furniture 0, the deeds from property 0.
 */
export const SHOP_LOOK_BASE = 512
export const SHOP_LOOK_END = 768

/** What a line is: something worn, a piece of furniture for a property, or a property's deed. */
export type ItemKind = 'wear' | 'furniture' | 'deed'

export interface StoreItem {
  /** The catalogue's own number, stable for ever (never reused, never renumbered); the card's key. */
  readonly id: number
  /** The unlock space its bit is in, and the bit: stable for ever like the id (the record remembers the bit). */
  readonly space: Space
  readonly index: number
  readonly shop: ShopKind
  readonly kind: ItemKind
  /** The section of the shop's card it is listed under. */
  readonly group: string
  readonly name: string
  /** The operator level it asks, 1..MAX_LEVEL. */
  readonly level: number
  /** Its price, whole civic credits. */
  readonly price: number
  /** The look slots it sets when worn (a 'wear' line); slots the wardrobe does not have yet put the line on order. */
  readonly wear: Readonly<Record<string, number>> | null
}

/** A worn line's bit is look 512 + id; a piece of furniture's is furniture id - 160; a deed's is property id - 224. */
const bitOf = (id: number, kind: ItemKind): { space: Space; index: number } =>
  kind === 'wear' ? { space: 'look', index: SHOP_LOOK_BASE + id } : kind === 'furniture' ? { space: 'furniture', index: id - 160 } : { space: 'property', index: id - 224 }

const item = (id: number, shop: ShopKind, kind: ItemKind, group: string, name: string, level: number, price: number, wear: Record<string, number> | null = null): StoreItem =>
  Object.freeze({ id, ...bitOf(id, kind), shop, kind, group, name, level, price, wear: wear && Object.freeze(wear) })

/**
 * The coats' colours in the wardrobe's coat palette order (look.ts LOOK_PALETTE.coats): the first six, the ones every
 * body's top slot reaches (the skirt suit's jacket palette has six).
 */
const COATS = ['charcoal', 'navy', 'walnut', 'camel', 'slate', 'espresso'] as const
/** The trims' colours, LOOK_PALETTE.trims order (trim 0 is "matching", so the n-th colour is trim n + 1). */
const TRIMS = ['black', 'ivory', 'burgundy', 'navy', 'camel', 'grey', 'teal'] as const
/** The scarves' colours, LOOK_PALETTE.scarves order (scarf 0 is none). */
const SCARVES = ['burgundy', 'navy', 'sand', 'charcoal', 'tan', 'cornflower', 'silver'] as const

/**
 * The catalogue, ids by shop: the tailor 0..47, the tattoo studio 48..95, the prosthetics atelier 96..127, the
 * horologist 128..159, the design house's furniture 160..223 and the deeds 224..230. The tattoo, limb, hearing and
 * accessory slots named here are the ones the customizer's update is to bring; until the wardrobe has them, their
 * lines are on order.
 */
export const CATALOGUE: readonly StoreItem[] = Object.freeze([
  // Verrin & Vale Tailors: coats (the layer and the coat's cloth), contrast trims, scarves, a tie.
  ...COATS.map((c, i) => item(i, 'tailor', 'wear', 'Overcoats', `Overcoat in ${c}`, [1, 1, 2, 3, 2, 4][i], [400, 400, 500, 650, 500, 800][i], { layer: 2, top: i })),
  ...TRIMS.map((c, i) => item(8 + i, 'tailor', 'wear', 'Contrast trims', `${c[0].toUpperCase()}${c.slice(1)} lapel and cuff trim`, [2, 2, 3, 3, 4, 5, 6][i], [250, 250, 350, 350, 450, 600, 900][i], { trim: i + 1 })),
  ...SCARVES.map((c, i) => item(16 + i, 'tailor', 'wear', 'Scarves', `${c[0].toUpperCase()}${c.slice(1)} scarf`, [1, 1, 2, 2, 3, 4, 5][i], [180, 180, 240, 240, 320, 450, 600][i], { scarf: i + 1 })),
  item(24, 'tailor', 'wear', 'Neckwear', 'Silk tie', 1, 120, { tie: 1 }),

  // Aethelgard Ink Studio: designs for the forearm (the studio's chair places them; other zones with the customizer).
  ...['Fine-line olive branch', 'Fibonacci spiral', 'Celtic knotwork band', 'Circuit-trace sleeve', 'Star-chart sleeve', 'Seigaiha waves',
    'Origami crane sequence', 'Soundwave band', 'Wayfinder compass', 'Botanical sleeve', 'Euler\'s identity in script', 'Ocean-wave armband']
    .map((name, i) => item(48 + i, 'inkStudio', 'wear', 'Designs', name, 1 + Math.floor(i / 2), 200 + i * 60, { tattooForearm: i + 1 })),
  item(64, 'inkStudio', 'wear', 'Inks', 'Gold-leaf ink', 12, 6000, { tattooInk: 3 }),
  item(65, 'inkStudio', 'wear', 'Inks', 'Luminescent ink', 16, 24000, { tattooInk: 4 }),

  // Bio-Frame Prosthetics Atelier: smart eyewear now; limbs and hearing tech with the customizer.
  item(96, 'prosthetics', 'wear', 'Eyewear', 'Smart eyewear', 2, 450, { eyewear: 1 }),
  item(97, 'prosthetics', 'wear', 'Limbs', 'Brushed-titanium arm', 3, 1200, { prostheticArm: 1 }),
  item(98, 'prosthetics', 'wear', 'Limbs', 'Matte carbon-fibre arm', 5, 2200, { prostheticArm: 2 }),
  item(99, 'prosthetics', 'wear', 'Limbs', 'Carbon-fibre running blade', 6, 3000, { prostheticLeg: 3 }),
  item(100, 'prosthetics', 'wear', 'Limbs', 'Skin-matched silicone leg', 4, 1800, { prostheticLeg: 4 }),
  item(101, 'prosthetics', 'wear', 'Hearing', 'Tinted hearing processor', 2, 600, { hearing: 1 }),

  // Escapement Row Horology: a briefcase now; the rest with the customizer.
  item(128, 'horology', 'wear', 'Leather goods', 'Leather briefcase', 1, 300, { bag: 1 }),
  item(129, 'horology', 'wear', 'Watches', 'Steel three-hand watch', 2, 700, { watch: 1 }),
  item(130, 'horology', 'wear', 'Watches', 'Tourbillon chronograph', 10, 18000, { watch: 2 }),
  item(131, 'horology', 'wear', 'Pins', 'Rank lapel pin', 3, 400, { lapelPin: 1 }),
  item(132, 'horology', 'wear', 'Weather', 'Folding umbrella', 1, 150, { umbrella: 1 }),
  item(133, 'horology', 'wear', 'Audio', 'Acoustic headphones', 4, 900, { headphones: 1 }),

  // Lintel & Lumen Design House: furniture for owned spaces, and the brokerage's deeds (both open with the properties).
  item(160, 'designHouse', 'furniture', 'Office', 'Curved walnut executive desk', 3, 2400),
  item(161, 'designHouse', 'furniture', 'Office', 'Six-screen console station', 6, 7500),
  item(162, 'designHouse', 'furniture', 'Office', 'Holographic city table', 10, 22000),
  item(163, 'designHouse', 'furniture', 'Living', 'Modular sectional sofa', 2, 1600),
  item(164, 'designHouse', 'furniture', 'Living', 'Floor-to-ceiling bookcase', 2, 1100),
  item(165, 'designHouse', 'furniture', 'Living', 'Espresso and juice bar', 5, 4200),
  item(166, 'designHouse', 'furniture', 'Living', 'Acoustic grand piano', 9, 16000),
  item(167, 'designHouse', 'furniture', 'Living', 'Hydroponic green wall', 4, 2800),
  item(168, 'designHouse', 'furniture', 'Staff', 'Agent workstation', 3, 1500),
  item(224, 'designHouse', 'deed', 'Deeds', 'Metro-Line Micro-Loft', 1, 0),
  item(225, 'designHouse', 'deed', 'Deeds', 'Midtown Brownstone', 3, 4000),
  item(226, 'designHouse', 'deed', 'Deeds', 'Pierside Timber Loft', 6, 18000),
  item(227, 'designHouse', 'deed', 'Deeds', 'Crimson Tower Penthouse', 10, 75000),
  item(228, 'designHouse', 'deed', 'Deeds', 'Lakefront Glass Villa', 14, 320000),
  item(229, 'designHouse', 'deed', 'Deeds', 'Sovereign Lakefront Estate', 17, 1100000),
  item(230, 'designHouse', 'deed', 'Deeds', 'Crown Spire Sky-Mansion', 20, 4500000),
])

const BY_ID: ReadonlyMap<number, StoreItem> = new Map(CATALOGUE.map((i) => [i.id, i]))

/** The line of that id, or null. */
export const itemById = (id: number): StoreItem | null => BY_ID.get(id) ?? null

/** A shop's lines, in catalogue order. */
export const itemsOf = (shop: ShopKind): readonly StoreItem[] => CATALOGUE.filter((i) => i.shop === shop)

/**
 * Whether a line can be sold today: a 'wear' line whose every slot the wardrobe has. Furniture and deeds wait for
 * the properties (on order). `slots` is the wardrobe's (look.ts LOOK_SLOTS), a parameter so a test can widen it.
 */
export function onSale(i: StoreItem, slots: readonly string[] = LOOK_SLOTS): boolean {
  return i.kind === 'wear' && i.wear !== null && Object.keys(i.wear).every((s) => slots.includes(s))
}

/**
 * `look` wearing line `i`: each of its slots set in turn through withLookSlot, or null when the line is not on sale
 * or the look cannot take it (a value that body's slot does not have).
 */
export function wearItem(look: Look, i: StoreItem): Look | null {
  if (!onSale(i) || !i.wear) return null
  let out: Look | null = look
  for (const [slot, value] of Object.entries(i.wear)) {
    out = out && withLookSlot(out, slot as LookSlot, value)
    if (!out) return null
  }
  return out
}

/** Whether `look` already wears everything line `i` sets. */
export function wearing(look: Look, i: StoreItem): boolean {
  if (!onSale(i) || !i.wear) return false
  return Object.entries(i.wear).every(([slot, value]) => look[slot as LookSlot] === value)
}

// ---------------------------------------------------------------- bits and the practice gate

/** A space's bits, none set (the practice purse's; the progression record keeps its own). */
export const emptyBits = (space: Space): Uint32Array => new Uint32Array(SPACE_SIZE[space] / 32)

/** Whether bit `index` is set (false for an index outside the bits). */
export function hasBit(bits: Uint32Array, index: number): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= bits.length * 32) return false
  return ((bits[index >>> 5] >>> (index & 31)) & 1) === 1
}

/**
 * The verdicts: bought, or why not. The same numbers as the progression engine's purchase results (progression.ts
 * PURCHASE: bought 0, owned 1, level 2, credits 3, invalid 4); 4 here also covers a line on order.
 */
export const GATE = Object.freeze({ bought: 0, owned: 1, level: 2, credits: 3, unavailable: 4 })
export type GateVerdict = (typeof GATE)[keyof typeof GATE]

/**
 * The practice purse's gate on plain numbers: the line is bought when the level is reached, the credits cover the
 * price and the bit is clear; then the price is taken from `wallet[1]` and the bit set in one pass, the writes masked
 * by the verdict rather than branched on (the plan's style). `wallet` is [level, credits] (whole numbers; credits
 * reach the millions, so the price is taken in doubles, scaled by 0 or 1, never masked as a 32-bit integer). Returns
 * the verdict: bought, or the first reason in the order owned, level, credits (the progression gate's order).
 */
export function purchaseGate(wallet: Float64Array, bits: Uint32Array, index: number, level: number, price: number): GateVerdict {
  const word = index >>> 5, bit = (1 << (index & 31)) >>> 0
  const isOwned = ((bits[word] & bit) !== 0 ? 1 : 0)
  const levelOk = wallet[0] >= level ? 1 : 0
  const fundsOk = wallet[1] >= price ? 1 : 0
  const can = levelOk & fundsOk & (1 ^ isOwned)
  wallet[1] -= price * can
  bits[word] = (bits[word] | (bit & -can)) >>> 0
  // 0 bought; else 1 owned, 2 level, 3 credits: the first that failed.
  return ((1 - can) * (isOwned ? GATE.owned : levelOk === 0 ? GATE.level : GATE.credits)) as GateVerdict
}

/** What a shop says about a line with this verdict, in words (`credits` is the purse's balance). */
export function whyOf(i: StoreItem, verdict: GateVerdict, credits: number): string {
  switch (verdict) {
    case GATE.owned: return 'owned'
    case GATE.level: return `needs level ${i.level}`
    case GATE.credits: return `needs ${Math.max(0, i.price - credits).toLocaleString('en-CA')} more credits`
    case GATE.bought: return 'for sale'
    default: return onSale(i) ? 'not for sale' : i.kind === 'wear' ? 'on order: arrives with the wardrobe update' : 'on order: opens with the properties'
  }
}

/** Credits as the card writes them: "1,250 cr". */
export const credits = (n: number): string => `${Math.max(0, Math.floor(n)).toLocaleString('en-CA')} cr`
