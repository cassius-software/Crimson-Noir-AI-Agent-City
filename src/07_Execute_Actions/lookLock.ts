// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the wardrobe's shop lock (decided 2026-11-12): an option a shop sells is locked on
 * the player's own look until it is bought, and everything else stays free. A lock is what one catalogue line sells
 * (storeCatalog.ts CATALOGUE: the slots it sets, less the ones that only say how it is worn, the rolled sleeves a
 * design comes with), held until that line is owned; a design is held on every zone, so the forearm's design is not
 * free on the hand; and the coat itself is held until any overcoat is owned, so a coat in the one colour no line sells
 * is no way round the tailor. What the look wore when the card opened is kept (`kept`): it stays on, and its option
 * stays chosen, until it is taken off and the card closed. The atelier's limbs, glasses and hearing aids are never
 * locked: they are the body and its aids, and nobody buys their own body.
 *
 * The card asks heldBy for each option (the look the option would give), and a choice that bundles many slots (a
 * preset, Randomise, Reset, a pasted code; the console's preset, code, random and reset) goes through fitLook, which
 * puts back what the shops still hold and says what it held; the console's single choices (a slot, a garment) are
 * refused with the words lockWords gives. Agents' looks stay free: the shops sell to the player.
 * What breaks if it is removed? The shops' worn lines are the wardrobe's options for free, and buying one buys nothing.
 */
import { SHOP_INFO, type ShopKind } from '../01_Initialize_World/storefronts.ts'
import { LAYER, LOOK_SLOTS, changeLook, withLookSlot, type Look, type LookChange, type LookSlot } from '../03_Spawn_Agents/look.ts'
import { TATTOO_ZONES } from '../03_Spawn_Agents/tattoo.ts'
import { CATALOGUE, credits, onSale, type StoreItem } from './storeCatalog.ts'

/** Whether the player owns catalogue line `line` (the shopkeeper's owns, by the line's id). */
export type Owns = (line: StoreItem) => boolean

/** The shops whose lines never lock an option: the atelier's limbs, glasses and hearing aids are the body and its aids. */
export const FREE_SHOPS: ReadonlySet<ShopKind> = new Set<ShopKind>(['prosthetics'])

/** The slots that say how a line is worn, not what it sells: a design rolls the sleeves, and sleeves stay free. */
export const HOW_WORN: ReadonlySet<string> = new Set(['sleeves'])

/** The tattoo zones the wardrobe has slots for (a design's lock reads every one). */
const ZONES: readonly LookSlot[] = TATTOO_ZONES.map((z) => z.slot).filter((s) => (LOOK_SLOTS as readonly string[]).includes(s)) as LookSlot[]
const isZone = (slot: string): boolean => (ZONES as readonly string[]).includes(slot)

/** One lock: what the card calls it, the lines that open it (any one owned), whether a look wears what it holds, and the slots that take it off. */
export interface LookLock {
  readonly name: string
  readonly lines: readonly StoreItem[]
  wears(look: Look): boolean
  /** The slots of `look` that hold it, the first one first: putting that one back alone takes most locks off (a coat's layer). */
  slots(look: Look): readonly LookSlot[]
}

/** What line `i` sells: the slots it sets, less those that say how it is worn. */
const goodsOf = (i: StoreItem): [LookSlot, number][] => Object.entries(i.wear ?? {}).filter(([s]) => !HOW_WORN.has(s)) as [LookSlot, number][]

function lineLock(i: StoreItem): LookLock {
  const goods = goodsOf(i)
  // A design is the design wherever it is inked: held on every zone, put back zone by zone.
  const design = goods.length === 1 && isZone(goods[0][0]) ? goods[0][1] : null
  if (design !== null) {
    return Object.freeze({ name: i.name, lines: Object.freeze([i]), wears: (look: Look) => ZONES.some((z) => look[z] === design), slots: (look: Look) => ZONES.filter((z) => look[z] === design) })
  }
  const slots = Object.freeze(goods.map(([s]) => s))
  return Object.freeze({ name: i.name, lines: Object.freeze([i]), wears: (look: Look) => goods.every(([s, v]) => look[s] === v), slots: () => slots })
}

/** The lines that lock an option: every worn line on sale, but the atelier's. */
export const LOCKED_LINES: readonly StoreItem[] = Object.freeze(CATALOGUE.filter((i) => i.kind === 'wear' && onSale(i) && !FREE_SHOPS.has(i.shop) && goodsOf(i).length > 0))

/** The overcoats: the lines that sell the coat layer. */
const COAT_LINES: readonly StoreItem[] = Object.freeze(LOCKED_LINES.filter((i) => i.wear?.layer === LAYER.coat))

/**
 * Every lock, each line's first, then the coat itself: held while the layer is the coat and no overcoat is owned, so
 * the coat palette's seventh colour, which no line sells, is still the tailor's coat.
 */
export const LOOK_LOCKS: readonly LookLock[] = Object.freeze([
  ...LOCKED_LINES.map(lineLock),
  ...(COAT_LINES.length
    ? [Object.freeze({ name: 'a coat', lines: COAT_LINES, wears: (look: Look) => look.layer === LAYER.coat, slots: () => Object.freeze(['layer'] as LookSlot[]) })]
    : []),
])

/** Whether lock `l` is open: one of its lines owned. */
export const isOpen = (l: LookLock, owns: Owns): boolean => l.lines.some((i) => owns(i))

/** The locks that hold `look`: what it wears that `kept` does not, with none of their lines owned. */
export function holding(look: Look, kept: Look, owns: Owns): LookLock[] {
  return LOOK_LOCKS.filter((l) => l.wears(look) && !l.wears(kept) && !isOpen(l, owns))
}

/**
 * The one line a card names for `locks`: the line that opens the most of them (the navy overcoat opens the coat too),
 * then the cheapest, then the catalogue's order. Null for no locks.
 */
export function lineFor(locks: readonly LookLock[]): StoreItem | null {
  let best: StoreItem | null = null
  let bestOpens = 0
  for (const l of locks) {
    for (const i of l.lines) {
      const opens = locks.filter((m) => m.lines.includes(i)).length
      if (best === null || opens > bestOpens || (opens === bestOpens && i.price < best.price)) { best = i; bestOpens = opens }
    }
  }
  return best
}

/**
 * What `look` wears that a shop sells and nobody bought, by name: the pieces kept on from before (the card says they
 * stay until taken off). The coat itself is named only when no overcoat's own line already names it.
 */
export function wornFromShops(look: Look, owns: Owns): string[] {
  const worn = LOOK_LOCKS.filter((l) => l.wears(look) && !isOpen(l, owns))
  return worn.filter((l) => l.lines.length === 1 || !worn.some((m) => m !== l && m.lines.length === 1 && l.lines.includes(m.lines[0]))).map((l) => l.name)
}

/** The line that holds `look` (it wears something a shop sells that `kept` did not wear and nobody bought), or null. */
export const heldBy = (look: Look, kept: Look, owns: Owns): StoreItem | null => lineFor(holding(look, kept, owns))

/** `look` with `slots` put back to `base`'s values, or to 0 where `base`'s no longer fits; null when neither fits. */
function putBack(look: Look, slots: readonly LookSlot[], base: Look | null): Look | null {
  let out: Look | null = look
  for (const s of slots) {
    if (!out) return null
    out = (base ? withLookSlot(out, s, base[s]) : null) ?? withLookSlot(out, s, 0)
  }
  return out
}

/**
 * `next` with what the shops still hold put back, and the lines that held it: for each lock that holds it (holding),
 * its first slot is put back to `base`'s (the look before the change), then all its slots, then to none; a look that
 * cannot be fitted stays `base`. `kept` is what stays on although a shop sells it (the look when the card opened).
 */
export function fitLook(next: Look, base: Look, kept: Look, owns: Owns): { look: Look; held: StoreItem[] } {
  const held: StoreItem[] = []
  let out = next
  for (let pass = 0; pass <= LOOK_LOCKS.length; pass++) {
    const locks = holding(out, kept, owns)
    if (!locks.length) return { look: out, held }
    const line = lineFor(locks)
    if (line && !held.includes(line)) held.push(line)
    const lock = locks[0]
    const slots = lock.slots(out)
    const fitted = [putBack(out, slots.slice(0, 1), base), putBack(out, slots, base), putBack(out, slots, null)]
      .find((l): l is Look => l !== null && !lock.wears(l))
    if (!fitted) return { look: base, held }
    out = fitted
  }
  return holding(out, kept, owns).length ? { look: base, held } : { look: out, held }
}

/** What a card's lock says: the shop and the price ("Verrin & Vale Tailors · 120 cr"). */
export const lockLabel = (i: StoreItem): string => `${SHOP_INFO[i.shop].name} · ${credits(i.price)}`

/** The lock in words: the line, its shop and where it stands, its price and its level. */
export const lockWords = (i: StoreItem): string =>
  `${i.name}: sold at ${SHOP_INFO[i.shop].name}, ${SHOP_INFO[i.shop].arcade}, for ${credits(i.price)} (level ${i.level}); buy it there to wear it`

/** The lines `held` in a few words, for a note ("Silk tie (Verrin & Vale Tailors, 120 cr)"). */
export const heldWords = (held: readonly StoreItem[]): string =>
  held.map((i) => `${i.name} (${SHOP_INFO[i.shop].name}, ${credits(i.price)})`).join(', ')

/**
 * The console's `look` change through the lock: a slot or a garment that would put on something the shops hold is
 * refused in lockWords' words; a preset, a code, a seed's look or the reset is worn with what is held put back
 * (fitLook, against the look worn now), and `held` says what. Otherwise changeLook's own answer.
 */
export function changeLookLocked(look: Look, change: LookChange, seed: number, owns: Owns):
  { readonly look: Look; readonly error: null; readonly held: readonly StoreItem[] } | { readonly look: null; readonly error: string; readonly held: readonly StoreItem[] } {
  const r = changeLook(look, change, seed)
  if (r.look === null) return { look: null, error: r.error, held: [] }
  if (change.kind === 'slot' || change.kind === 'garment') {
    const line = heldBy(r.look, look, owns)
    return line ? { look: null, error: lockWords(line), held: [line] } : { look: r.look, error: null, held: [] }
  }
  const fit = fitLook(r.look, look, look, owns)
  return { look: fit.look, error: null, held: fit.held }
}
