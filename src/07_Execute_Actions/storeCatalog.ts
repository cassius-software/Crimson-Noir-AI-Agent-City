// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is what the five storefronts (01_Initialize_World/storefronts.ts) sell and the rule a
 * purchase passes: every catalogue line with its stable id, its shop, the operator level it asks and its price in
 * civic credits, the bit it owns in the progression record's unlock spaces (look, property, furniture: the
 * progression engine's purchase gate, docs/progression.md), and what it does when worn (the look slots it sets,
 * through look.ts withLookSlot, so nothing a shop sells can dress anyone in anything the crowd does not wear); and
 * the words for the gate's verdicts.
 *
 * A line whose look slots the wardrobe does not have yet (tattoos, watches: the customizer's coming slots) is on
 * order: shown, priced, never sold, and live the moment the wardrobe gains a slot of that name. The property deeds
 * are on sale, because the seven homes stand in both maps (01_Initialize_World/properties.ts), and so is the design
 * house's furniture, because a home's owner can place it (the home card's furnishing view, HomeCard.tsx): a furniture
 * line is a licence for every home the player owns, up to its cap in each.
 *
 * The level, the credits and what is owned are not kept here: the progression engine's keeper answers for them
 * (07_Execute_Actions/progress.ts, through shopkeeper.ts), and its purchase gate takes the credits and sets the bit.
 * What breaks if it is removed? The shops have nothing to sell and nothing decides whether a purchase may happen.
 */
import { LOOK_SLOTS, withLookSlot, type Look, type LookSlot } from '../03_Spawn_Agents/look.ts'
import type { ShopKind } from '../01_Initialize_World/storefronts.ts'
import { MAX_LEVEL, UNLOCK_SPACE } from '../02_Define_The_Rules/progression.ts'

/** The highest operator level (the progression engine's). */
export { MAX_LEVEL }

/**
 * The progression record's unlock spaces and their sizes (progression.ts UNLOCK_SPACE): an item's bit is an index in
 * one of them, and keeps its meaning for ever once shipped.
 */
export const SPACE_SIZE = Object.freeze({ look: UNLOCK_SPACE.look.size, property: UNLOCK_SPACE.property.size, furniture: UNLOCK_SPACE.furniture.size })
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

  // Bio-Frame Prosthetics Atelier: smart eyewear, four fitted limbs and a hearing processor. A limb line sets the
  // wardrobe's limb and finish (look.ts PROSTHETIC, WARDROBE.prostheticFinish) and says its side in its name; the
  // wardrobe itself offers every limb, side and finish at no cost, so nobody has to buy their own body.
  item(96, 'prosthetics', 'wear', 'Eyewear', 'Smart eyewear', 2, 450, { eyewear: 1 }),
  item(97, 'prosthetics', 'wear', 'Limbs', 'Brushed-titanium right arm', 3, 1200, { prosthetic: 2, prostheticFinish: 2 }),
  item(98, 'prosthetics', 'wear', 'Limbs', 'Matte carbon-fibre left arm', 5, 2200, { prosthetic: 1, prostheticFinish: 1 }),
  item(99, 'prosthetics', 'wear', 'Limbs', 'Carbon-fibre right lower leg', 6, 3000, { prosthetic: 4, prostheticFinish: 1 }),
  item(100, 'prosthetics', 'wear', 'Limbs', 'Skin-matched silicone left leg', 4, 1800, { prosthetic: 3, prostheticFinish: 3 }),
  item(101, 'prosthetics', 'wear', 'Hearing', 'Tinted hearing processor', 2, 600, { hearing: 1 }),

  // Escapement Row Horology: a briefcase now; the rest with the customizer.
  item(128, 'horology', 'wear', 'Leather goods', 'Leather briefcase', 1, 300, { bag: 1 }),
  item(129, 'horology', 'wear', 'Watches', 'Steel three-hand watch', 2, 700, { watch: 1 }),
  item(130, 'horology', 'wear', 'Watches', 'Tourbillon chronograph', 10, 18000, { watch: 2 }),
  item(131, 'horology', 'wear', 'Pins', 'Rank lapel pin', 3, 400, { lapelPin: 1 }),
  item(132, 'horology', 'wear', 'Weather', 'Folding umbrella', 1, 150, { umbrella: 1 }),
  item(133, 'horology', 'wear', 'Audio', 'Acoustic headphones', 4, 900, { headphones: 1 }),

  // Lintel & Lumen Design House: furniture for the homes one owns (placed through the home card), and the brokerage's deeds.
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
 * The kinds of line other than worn ones that are on sale now. The deeds opened with the homes, and furniture with
 * furnishing, so that nothing was ever sold before it could be placed. A worn line answers to the wardrobe instead.
 */
export const OPEN_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>(['deed', 'furniture'])

/**
 * Whether a line can be sold today: a 'wear' line whose every slot the wardrobe has, or a line of a kind in `open`
 * (a deed or a piece of furniture). `slots` is the wardrobe's (look.ts LOOK_SLOTS) and `open` is OPEN_KINDS; both
 * are parameters so a test can narrow or widen them.
 */
export function onSale(i: StoreItem, slots: readonly string[] = LOOK_SLOTS, open: ReadonlySet<ItemKind> = OPEN_KINDS): boolean {
  if (i.kind === 'wear') return i.wear !== null && Object.keys(i.wear).every((s) => slots.includes(s))
  return open.has(i.kind)
}

/**
 * `look` wearing line `i`: each of its slots set in turn through withLookSlot, or null when the line is not on sale,
 * is not worn at all (a deed, a piece of furniture) or the look cannot take it (a value that body's slot does not have).
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

/**
 * The lowest price among the lines of `kind` on sale today (onSale), or null when none is: the design house warns a
 * deed's buyer when what the deed leaves is less than the cheapest piece of furniture (StoreCard.tsx).
 */
export function cheapestOnSale(kind: ItemKind, slots: readonly string[] = LOOK_SLOTS, open: ReadonlySet<ItemKind> = OPEN_KINDS): number | null {
  let low: number | null = null
  for (const i of CATALOGUE) if (i.kind === kind && onSale(i, slots, open) && (low === null || i.price < low)) low = i.price
  return low
}

/** Whether `look` already wears everything line `i` sets. */
export function wearing(look: Look, i: StoreItem): boolean {
  if (!onSale(i) || !i.wear) return false
  return Object.entries(i.wear).every(([slot, value]) => look[slot as LookSlot] === value)
}

// ---------------------------------------------------------------- the gate's verdicts

/**
 * The verdicts: bought, or why not. The same numbers as the progression engine's purchase results (progression.ts
 * PURCHASE: bought 0, owned 1, level 2, credits 3, invalid 4); 4 here also covers a line on order.
 */
export const GATE = Object.freeze({ bought: 0, owned: 1, level: 2, credits: 3, unavailable: 4 })
export type GateVerdict = (typeof GATE)[keyof typeof GATE]

/** What a shop says about a line with this verdict, in words (`credits` is the purse's balance). */
export function whyOf(i: StoreItem, verdict: GateVerdict, credits: number): string {
  switch (verdict) {
    case GATE.owned: return 'owned'
    case GATE.level: return `needs level ${i.level}`
    case GATE.credits: return `needs ${Math.max(0, i.price - credits).toLocaleString('en-CA')} more credits`
    case GATE.bought: return 'for sale'
    default: return onSale(i) ? 'not for sale' : i.kind === 'wear' ? 'on order: arrives with the wardrobe update' : 'on order'
  }
}

/** Credits as the card writes them: "1,250 cr". */
export const credits = (n: number): string => `${Math.max(0, Math.floor(n)).toLocaleString('en-CA')} cr`
