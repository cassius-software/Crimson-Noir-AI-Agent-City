// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the shops' catalogue, the purse and the shopkeeper (storeCatalog.ts,
 * shopkeeper.ts) to their promises: ids and bits stable and unique, every bit inside its unlock space and the worn
 * lines inside the shops' own range of the look space; the spaces, the level cap and the verdicts the progression
 * engine's own (progression.ts); every worn line on sale dresses every body in something the wardrobe has; the deeds
 * and the furniture are on sale and dress nobody (furniture opened with furnishing, so no piece was sold before it
 * could be placed), and the cheapest piece on sale is the bookcase; a line on order is never sold; the progression
 * keeper (progress.ts createProgress) buys a line once, takes its price from the record, sets its bit and keeps both
 * across a reload, and refuses with the first reason; a new operator claims the free loft and is told the level the
 * brownstone and each piece of furniture need, and a keeper at those levels buys them; a keeper that refuses leaves no
 * bit; the atelier's four limbs are on sale, each the limb, side and finish its name says; the ink studio's twelve
 * designs are the wardrobe's first twelve, in order, under names that say what each draws, and its two inks the
 * wardrobe's gold leaf and luminescent, on sale; an ink tried on a look with no design borrows the olive branch for the
 * mirror alone (previewItem), never for what is bought; the 14A screen passes every name.
 * What breaks if it is removed? A shop could sell a line twice, sell a line nobody can wear, take credits for nothing,
 * or set a bit another thread's line means.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SHOP_KINDS } from '../01_Initialize_World/storefronts.ts'
import { CUT, LAYER, LOOK_PRESETS, LOOK_SLOTS, PROSTHETIC, SLEEVES, WARDROBE, tattooCover, validateLook, type LookSlot } from '../03_Spawn_Agents/look.ts'
import { TATTOO_INK, TATTOO_MOTIFS, TATTOO_ZONES } from '../03_Spawn_Agents/tattoo.ts'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { AT, MAX_LEVEL as PROGRESSION_MAX_LEVEL, PURCHASE, STARTING_CREDITS, UNLOCK_SPACE } from '../02_Define_The_Rules/progression.ts'
import { createProgress } from './progress.ts'
import {
  CATALOGUE, GATE, MAX_LEVEL, OPEN_KINDS, PREVIEW_TATTOO, SHOP_LOOK_BASE, SHOP_LOOK_END, SPACE_SIZE, cheapestOnSale, coverHint, isInkLine, itemById, itemsOf, onSale, previewItem, wearItem, wearing, whyOf,
  type ItemKind, type Space,
} from './storeCatalog.ts'
import { PROGRESS_WORD, createShopkeeper, progressionPurse, type ProgressLike } from './shopkeeper.ts'

/** A Map-backed localStorage. */
const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, m }
}

test('ids and bits are unique, every bit inside its space and the worn lines in the shops\' range; levels, prices and shops in range', () => {
  const ids = new Set<number>()
  const bits = new Set<string>()
  for (const i of CATALOGUE) {
    assert.ok(Number.isInteger(i.id) && i.id >= 0, `id ${i.id}`)
    assert.ok(!ids.has(i.id), `id ${i.id} twice`)
    ids.add(i.id)
    const bit = `${i.space}:${i.index}`
    assert.ok(!bits.has(bit), `${bit} twice`)
    bits.add(bit)
    assert.ok(Number.isInteger(i.index) && i.index >= 0 && i.index < SPACE_SIZE[i.space], `${i.name}: ${bit} outside its space`)
    assert.equal(i.space, i.kind === 'wear' ? 'look' : i.kind === 'furniture' ? 'furniture' : 'property')
    if (i.space === 'look') assert.ok(i.index >= SHOP_LOOK_BASE && i.index < SHOP_LOOK_END, `${i.name}: look ${i.index} outside the shops' range`)
    assert.ok(Number.isInteger(i.level) && i.level >= 1 && i.level <= MAX_LEVEL, `${i.name}: level ${i.level}`)
    assert.ok(Number.isInteger(i.price) && i.price >= 0 && i.price <= 2_000_000_000, `${i.name}: price ${i.price}`)
    assert.ok((SHOP_KINDS as readonly string[]).includes(i.shop))
    assert.equal(itemById(i.id), i)
    assert.ok(Object.isFrozen(i))
  }
  for (const shop of SHOP_KINDS) assert.ok(itemsOf(shop).length > 0, `${shop} lists nothing`)
  for (const shop of ['tailor', 'inkStudio', 'prosthetics', 'horology'] as const) assert.ok(itemsOf(shop).some((i) => onSale(i)), `${shop} sells nothing today`)
  assert.equal(itemById(9999), null)
  // Shipped bits keep their meaning: a few pinned by value.
  assert.deepEqual([itemById(0), itemById(24), itemById(96), itemById(128), itemById(160), itemById(224)].map((i) => `${i?.space}:${i?.index}`),
    ['look:512', 'look:536', 'look:608', 'look:640', 'furniture:0', 'property:0'])
})

test('the deeds are the plan\'s seven tiers, in level order, priced as its table, homes 0 to 6', () => {
  const deeds = CATALOGUE.filter((i) => i.kind === 'deed')
  assert.deepEqual(deeds.map((d) => d.level), [1, 3, 6, 10, 14, 17, 20])
  assert.deepEqual(deeds.map((d) => d.price), [0, 4000, 18000, 75000, 320000, 1100000, 4500000])
  assert.deepEqual(deeds.map((d) => d.index), [0, 1, 2, 3, 4, 5, 6])
})

test('deeds and furniture are on sale (furnishing opened its kind); without a kind in the open set, its lines are on order', () => {
  assert.deepEqual([...OPEN_KINDS], ['deed', 'furniture'])
  const deeds = CATALOGUE.filter((i) => i.kind === 'deed')
  const furniture = CATALOGUE.filter((i) => i.kind === 'furniture')
  assert.equal(deeds.length, 7)
  assert.equal(furniture.length, 9, 'the nine lines the home card places (homeLayout.ts SHAPES)')
  assert.ok(deeds.every((d) => d.shop === 'designHouse' && onSale(d)), 'the deeds are on sale')
  assert.ok(furniture.every((f) => f.shop === 'designHouse' && onSale(f)), 'every piece is on sale now that it can be placed')
  assert.ok(furniture.every((f) => f.wear === null && f.space === 'furniture' && f.index === f.id - 160), 'a piece is a licence bit, never worn')
  // Without furniture's kind a piece is on order again (as it was before furnishing), and without the deeds' a deed is.
  assert.ok(furniture.every((f) => !onSale(f, LOOK_SLOTS, new Set<ItemKind>(['deed']))))
  assert.ok(deeds.every((d) => !onSale(d, LOOK_SLOTS, new Set<ItemKind>())))
  // A kind in the open set never puts a worn line on sale: those answer to the wardrobe alone (here one without the umbrella).
  const noUmbrella = LOOK_SLOTS.filter((s) => s !== 'umbrella')
  assert.equal(onSale(itemById(132)!, noUmbrella, new Set<ItemKind>(['wear', 'deed', 'furniture'])), false)
  // The cheapest piece on sale (the design house's warning on a deed's row measures against it) is the bookcase.
  assert.equal(cheapestOnSale('furniture'), 1100)
  assert.equal(itemById(164)?.name, 'Floor-to-ceiling bookcase')
  assert.equal(cheapestOnSale('furniture', LOOK_SLOTS, new Set<ItemKind>(['deed'])), null, 'nothing on sale, no price')
  assert.equal(cheapestOnSale('deed'), 0, 'the free loft')
})

test('every worn line on sale dresses every preset body in a valid look; a deed on sale dresses nobody; a line on order is never sold nor worn', () => {
  for (const i of CATALOGUE) {
    if (!onSale(i)) {
      for (const p of LOOK_PRESETS) assert.equal(wearItem(p.look, i), null, `${i.name} is on order but wearable`)
      continue
    }
    if (i.kind !== 'wear') {
      // A deed is sold, never worn: nothing it sets, nothing anyone shows as wearing.
      assert.equal(i.wear, null, `${i.name} is not worn`)
      for (const p of LOOK_PRESETS) {
        assert.equal(wearItem(p.look, i), null, `${i.name} would be worn by the ${p.name}`)
        assert.equal(wearing(p.look, i), false)
      }
      continue
    }
    for (const p of LOOK_PRESETS) {
      const worn = wearItem(p.look, i)
      assert.ok(worn, `${i.name} cannot be worn by the ${p.name}`)
      assert.ok(validateLook(worn), `${i.name} on the ${p.name} is not a look`)
      assert.ok(wearing(worn, i), `${i.name} on the ${p.name} does not show as worn`)
    }
  }
  // Every worn line is on sale: the umbrella and the headphones (132, 133) were the last on order. A line is on order
  // while the wardrobe lacks one of its slots, and goes on sale the moment the wardrobe has them.
  assert.deepEqual(CATALOGUE.filter((i) => i.kind === 'wear' && !onSale(i)).map((i) => i.id), [])
  for (const id of [132, 133]) {
    const line = itemById(id)!
    const without = LOOK_SLOTS.filter((s) => !Object.hasOwn(line.wear!, s))
    assert.equal(onSale(line, without), false, `${line.name} on order without its slot`)
    assert.equal(onSale(line, [...without, ...Object.keys(line.wear!)]), true)
  }
})

test('the horologist sells the watches, the rank pin, the umbrella and the headphones now the wardrobe has the accessory word\'s slots for them', () => {
  for (const id of [128, 129, 130, 131, 132, 133]) assert.ok(onSale(itemById(id)!), `${itemById(id)!.name} is on sale`)
  // The lines' values are the wardrobe's names for what they sell, and wearing one sets that slot alone.
  assert.equal(WARDROBE.watch[itemById(129)!.wear!.watch], 'steel three-hand')
  assert.equal(WARDROBE.watch[itemById(130)!.wear!.watch], 'tourbillon chronograph')
  assert.equal(WARDROBE.lapelPin[itemById(131)!.wear!.lapelPin], 'rank pin')
  assert.equal(WARDROBE.umbrella[itemById(132)!.wear!.umbrella], 'folding')
  assert.equal(WARDROBE.headphones[itemById(133)!.wear!.headphones], 'over-ear', 'acoustic headphones are over-ear')
  for (const id of [129, 130, 131, 132, 133]) {
    const i = itemById(id)!
    const [slot, value] = Object.entries(i.wear!)[0]
    for (const p of LOOK_PRESETS) {
      const worn = wearItem(p.look, i)!
      assert.equal(worn[slot as keyof typeof worn], value, `${i.name} on the ${p.name}`)
      assert.deepEqual({ ...worn, [slot]: p.look[slot as keyof typeof worn] }, { ...p.look }, `${i.name} sets ${slot} alone`)
    }
  }
})

test('the atelier\'s four limbs are on sale, each setting the wardrobe\'s limb and finish its name says', () => {
  const finish = (name: string) => WARDROBE.prostheticFinish.indexOf(name)
  const limbs: readonly [number, string, number, number][] = [
    [97, 'Brushed-titanium right arm', PROSTHETIC.rightArm, finish('chrome')],
    [98, 'Matte carbon-fibre left arm', PROSTHETIC.leftArm, finish('carbon')],
    [99, 'Carbon-fibre right lower leg', PROSTHETIC.rightLeg, finish('carbon')],
    [100, 'Skin-matched silicone left leg', PROSTHETIC.leftLeg, finish('skin-matched')],
  ]
  assert.deepEqual(itemsOf('prosthetics').filter((i) => i.group === 'Limbs').map((i) => i.id), limbs.map(([id]) => id))
  for (const [id, name, limb, fin] of limbs) {
    const i = itemById(id)!
    assert.equal(i.name, name)
    assert.ok(fin >= 0, `${name}: its finish is in the wardrobe`)
    assert.deepEqual(i.wear, { prosthetic: limb, prostheticFinish: fin })
    assert.ok(onSale(i), `${name} is still on order`)
    assert.equal(whyOf(i, GATE.unavailable, 0), 'not for sale', `${name} is refused, not on order`)
    for (const p of LOOK_PRESETS) {
      const worn = wearItem(p.look, i)!
      assert.equal(worn.prosthetic, limb, `${name} on the ${p.name}`)
      assert.equal(worn.prostheticFinish, fin, `${name} on the ${p.name}`)
    }
  }
})

test('the ink studio\'s twelve designs are the wardrobe\'s designs 1 to 12, in catalogue order, on sale on the left forearm with the sleeves rolled; its two inks are the wardrobe\'s gold leaf and luminescent, on sale now that the wardrobe has the ink', () => {
  // A design line wears `tattooForearm: i + 1` with the sleeves rolled, so its design is the wardrobe's id i + 1 by
  // construction (tattoo.ts) and what is bought is what the mirror showed: a design under a sleeve shows nothing.
  const motifs = [
    'olive branch', 'fibonacci spiral', 'braided rope band', 'circuit trace', 'star chart', 'scalloped arc band',
    'origami cranes', 'soundwave band', 'compass rose', 'botanical vine', 'euler identity', 'ocean wave band',
  ]
  // The shop's own names: four were renamed for what the drawing shows (a rope's braid, a band of scalloped arcs, a
  // compass rose, the unit circle's half turn), so none names a people, a culture's pattern or a declined symbol; the
  // ids, and so the bits already bought, stay as they were.
  const names = [
    'Fine-line olive branch', 'Fibonacci spiral', 'Braided rope band', 'Circuit-trace sleeve', 'Star-chart sleeve', 'Scalloped arc band',
    'Origami crane sequence', 'Soundwave band', 'Compass rose', 'Botanical sleeve', 'Euler\'s identity circle', 'Ocean-wave armband',
  ]
  const designs = itemsOf('inkStudio').filter((i) => i.group === 'Designs')
  assert.deepEqual(designs.map((i) => i.id), Array.from({ length: 12 }, (_, i) => 48 + i), 'lines 48 to 59')
  assert.deepEqual(designs.map((i) => i.name), names)
  assert.deepEqual(designs.map((i) => i.index), Array.from({ length: 12 }, (_, i) => SHOP_LOOK_BASE + 48 + i), 'their bits are their ids\'')
  for (const [i, line] of designs.entries()) {
    assert.deepEqual(line.wear, { tattooForearm: i + 1, sleeves: SLEEVES.rolled }, line.name)
    assert.equal(TATTOO_MOTIFS[line.wear!.tattooForearm - 1].name, motifs[i], `${line.name} is the wardrobe's ${motifs[i]}`)
    assert.equal(WARDROBE.tattoo[line.wear!.tattooForearm], motifs[i])
    // The shop's name carries its design's first word, so the card and the wardrobe read as the same drawing.
    assert.ok(line.name.toLowerCase().replace(/[-']/g, ' ').split(' ').includes(motifs[i].split(' ')[0]), `${line.name} names the ${motifs[i]}`)
    assert.ok(onSale(line), `${line.name} is on sale`)
    assert.equal(isInkLine(line), false)
    for (const p of LOOK_PRESETS) {
      const worn = wearItem(p.look, line)!
      assert.deepEqual(worn, validateLook({ ...p.look, tattooForearm: i + 1, sleeves: SLEEVES.rolled }), `${line.name} on the ${p.name}`)
      // Shown on the forearm unless a coat keeps the sleeves down (the coat presets), which the try-on says in words.
      assert.equal(tattooCover(worn, 'tattooForearm'), worn.layer === LAYER.coat ? 'a coat keeps its sleeves down' : null, `${line.name} on the ${p.name}`)
      assert.equal(coverHint(p.look, line), tattooCover(worn, 'tattooForearm'), `${line.name} on the ${p.name}: the card's hint`)
    }
    // The card's hint names what hides the design: a coat's sleeves, or a prosthetic arm on the left.
    const jacket = validateLook({ ...LOOK_PRESETS[0].look, layer: LAYER.jacket, prosthetic: 0 })!
    assert.equal(coverHint(jacket, line), null)
    assert.equal(coverHint({ ...jacket, layer: LAYER.coat }, line), 'a coat keeps its sleeves down')
    assert.equal(coverHint({ ...jacket, prosthetic: PROSTHETIC.leftArm }, line), 'covered by the limb')
    assert.equal(coverHint({ ...jacket, prosthetic: PROSTHETIC.rightArm }, line), null, 'the right arm leaves the left forearm')
  }
  // The inks: each line's value is the wardrobe's ink its name says, and wearing one sets the ink alone.
  const inks = itemsOf('inkStudio').filter((i) => i.group === 'Inks')
  assert.deepEqual(inks.map((i) => i.id), [64, 65])
  for (const [id, ink, name] of [[64, TATTOO_INK.goldLeaf, 'gold leaf'], [65, TATTOO_INK.luminescent, 'luminescent']] as const) {
    const line = itemById(id)!
    assert.deepEqual(line.wear, { tattooInk: ink })
    assert.equal(WARDROBE.tattooInk[ink], name, `${line.name} is the wardrobe's ${name}`)
    assert.equal(line.name.toLowerCase().replace(/-/g, ' '), `${name} ink`, `${line.name}: the name is the value's`)
    assert.ok(onSale(line), `${line.name} is on sale`)
    assert.ok(isInkLine(line))
    for (const p of LOOK_PRESETS) assert.deepEqual(wearItem(p.look, line), { ...p.look, tattooInk: ink }, `${line.name} on the ${p.name} sets the ink alone`)
  }
})

test('the try-on: an ink on a look with no design showing borrows the olive branch for the mirror, on the left hand or the first zone nothing covers; with a design showing, or any other line, it is wearItem\'s look; buying still wears the ink alone', () => {
  assert.deepEqual({ ...PREVIEW_TATTOO }, { slot: 'tattooHand', design: 1 })
  assert.equal(WARDROBE.tattoo[PREVIEW_TATTOO.design], 'olive branch')
  assert.equal(TATTOO_ZONES.find((z) => z.slot === PREVIEW_TATTOO.slot)?.label, 'Left hand')
  for (const id of [64, 65]) {
    const line = itemById(id)!
    const ink = line.wear!.tattooInk
    for (const p of LOOK_PRESETS) {
      // No design on any zone the wardrobe has (the presets wear none): the mirror shows the ink on the olive branch.
      assert.deepEqual(previewItem(p.look, line), { ...p.look, tattooInk: ink, tattooHand: 1 }, `${line.name} on the ${p.name}`)
      assert.ok(validateLook(previewItem(p.look, line)!))
      // A design on any of the four zones that nothing covers: nothing is borrowed. One the cup covers (the camel
      // blazer's right hand) shows nothing, so the olive branch is lent to the left hand as well.
      for (const z of TATTOO_ZONES.filter((zone) => (LOOK_SLOTS as readonly string[]).includes(zone.slot))) {
        const inked = validateLook({ ...p.look, [z.slot]: 30 })!
        if (tattooCover(inked, z.slot as LookSlot) === null) {
          assert.deepEqual(previewItem(inked, line), wearItem(inked, line), `${line.name} over a design on the ${z.label}`)
          assert.deepEqual(previewItem(inked, line), { ...inked, tattooInk: ink })
        } else {
          assert.deepEqual(previewItem(inked, line), { ...inked, tattooInk: ink, tattooHand: 1 }, `${line.name} over a covered design on the ${z.label}`)
        }
      }
    }
  }
  // The olive branch goes where nothing covers it: past a prosthetic left arm to the right hand, past both arms to the
  // neck, past both arms and a turtleneck under a jacket to the nape; a design under the limb alone borrows too.
  const gold = itemById(64)!
  const bare = validateLook({ ...LOOK_PRESETS[0].look, cup: 0 })!
  const lent = (look: object) => previewItem(validateLook({ ...bare, ...look })!, gold)
  assert.deepEqual(lent({ prosthetic: PROSTHETIC.leftArm }), { ...bare, prosthetic: PROSTHETIC.leftArm, tattooInk: 3, tattooHandR: 1 })
  assert.deepEqual(lent({ prosthetic: PROSTHETIC.bothArms }), { ...bare, prosthetic: PROSTHETIC.bothArms, tattooInk: 3, tattooNeck: 1 })
  const knit = { prosthetic: PROSTHETIC.bothArms, cut: CUT.turtleneck, layer: LAYER.coat }
  assert.deepEqual(lent(knit), validateLook({ ...bare, ...knit, tattooInk: 3, tattooNape: 1 }))
  assert.deepEqual(lent({ prosthetic: PROSTHETIC.leftArm, tattooHand: 30 }), { ...bare, prosthetic: PROSTHETIC.leftArm, tattooHand: 30, tattooInk: 3, tattooHandR: 1 })
  assert.deepEqual(lent({ prosthetic: PROSTHETIC.rightArm, tattooHand: 30 }), { ...bare, prosthetic: PROSTHETIC.rightArm, tattooHand: 30, tattooInk: 3 })
  // An ink, or any line that sets no design, has no hint of its own.
  for (const i of CATALOGUE.filter((line) => !(line.wear && Object.hasOwn(line.wear, 'tattooForearm')))) {
    for (const p of LOOK_PRESETS) assert.equal(coverHint(p.look, i), null, `${i.name} on the ${p.name}`)
  }
  // Every other line on sale previews as it is worn, and a line on order previews as nothing.
  for (const i of CATALOGUE.filter((line) => !isInkLine(line))) {
    for (const p of LOOK_PRESETS) assert.deepEqual(previewItem(p.look, i), wearItem(p.look, i), `${i.name} on the ${p.name}`)
  }
  assert.deepEqual(previewItem(LOOK_PRESETS[0].look, itemById(132)!), { ...LOOK_PRESETS[0].look, umbrella: 1 }, 'the umbrella is on sale and previews as worn')
  assert.equal(previewItem(LOOK_PRESETS[0].look, { ...itemById(132)!, wear: { heel: 1 } }), null, 'a line on order (a slot the wardrobe lacks) previews as nothing')
  // Buying wears wearItem's look through the keeper: the ink alone, never the borrowed design.
  const k = createShopkeeper({ purse: { level: () => MAX_LEVEL, credits: () => 0, owns: () => true, canBuy: () => GATE.owned, buy: () => GATE.owned, subscribe: () => () => {} } })
  assert.deepEqual(k.wear(64, LOOK_PRESETS[0].look), { ...LOOK_PRESETS[0].look, tattooInk: TATTOO_INK.goldLeaf })
})

test('every name passes the 14A screen and names no real place', () => {
  for (const i of CATALOGUE) {
    assert.ok(screen(i.name).admissible, `${i.name} fails the screen`)
    assert.doesNotMatch(i.name, /\b(?:Toronto|Harbourfront|Yonge|Domus|Chronos|Sovereign Threads?|Apex Citadel|Citadel Apex)\b|matrix/i)
  }
})

test('whyOf says why in words', () => {
  const coat = itemById(3)!
  assert.match(whyOf(coat, GATE.level, 0), /needs level 3/)
  assert.match(whyOf(coat, GATE.credits, 10), /640 more credits/)
  assert.equal(whyOf(coat, GATE.bought, 9999), 'for sale')
  assert.equal(whyOf(coat, GATE.owned, 0), 'owned')
  assert.match(whyOf({ ...itemById(132)!, wear: { heel: 1 } }, GATE.unavailable, 0), /on order/, 'a worn line with a slot the wardrobe lacks')
  assert.equal(whyOf(itemById(132)!, GATE.unavailable, 0), 'not for sale', 'the umbrella is on sale, so an unavailable one is refused, not on order')
  assert.equal(whyOf(itemById(48)!, GATE.unavailable, 0), 'not for sale', 'the forearm\'s designs are on sale, so an unavailable one is refused, not on order')
  assert.equal(whyOf(itemById(160)!, GATE.unavailable, 0), 'not for sale', 'furniture is on sale too, so an unavailable piece is refused, not on order')
  assert.match(whyOf(itemById(160)!, GATE.level, 0), /needs level 3/)
  assert.match(whyOf(itemById(164)!, GATE.credits, 150), /950 more credits/)
  assert.equal(whyOf(itemById(225)!, GATE.unavailable, 0), 'not for sale', 'a deed is on sale, so an unavailable one is refused, not on order')
  assert.match(whyOf(itemById(226)!, GATE.level, 0), /needs level 6/)
})

test('the shops speak the progression engine\'s numbers: its spaces, its level cap, its verdicts, its record words', () => {
  for (const space of Object.keys(UNLOCK_SPACE) as Space[]) assert.equal(SPACE_SIZE[space], UNLOCK_SPACE[space].size, space)
  assert.deepEqual(Object.keys(SPACE_SIZE), Object.keys(UNLOCK_SPACE))
  assert.equal(MAX_LEVEL, PROGRESSION_MAX_LEVEL)
  assert.deepEqual([GATE.bought, GATE.owned, GATE.level, GATE.credits, GATE.unavailable],
    [PURCHASE.bought, PURCHASE.owned, PURCHASE.level, PURCHASE.credits, PURCHASE.invalid])
  assert.deepEqual({ ...PROGRESS_WORD }, { level: AT.level, credits: AT.credits })
})

test('the progression keeper behind the shopkeeper: a new operator\'s level and credits, bought once, kept across a reload', () => {
  const s = memory()
  const p = createProgress({ store: s, seed: () => 1337, now: () => 0 })
  const k = createShopkeeper({ purse: progressionPurse(p) })
  assert.equal(k.purse.level(), 1)
  assert.equal(k.purse.credits(), STARTING_CREDITS)
  let calls = 0
  const off = k.onChange(() => { calls++ })
  const look = LOOK_PRESETS[0].look
  const tie = itemById(24)!
  assert.ok(onSale(tie) && tie.level === 1 && tie.price <= STARTING_CREDITS, 'a first-floor line a new operator can afford')
  assert.equal(k.wear(24, look), null, 'not owned: not worn')
  const rows = k.rows('tailor', look)
  assert.equal(rows.find((r) => r.item.id === 24)!.verdict, GATE.bought)
  assert.equal(rows.find((r) => r.item.id === 5)!.verdict, GATE.level, 'a level 2 line at level 1')
  assert.equal(rows.find((r) => r.item.id === 0)!.verdict, GATE.credits)
  assert.match(rows.find((r) => r.item.id === 0)!.why, /250 more credits/)
  const r = k.buy(24)
  assert.equal(r.verdict, GATE.bought, r.message)
  assert.equal(k.purse.credits(), STARTING_CREDITS - tie.price, 'the price taken from the record')
  assert.equal(p.record[AT.credits], STARTING_CREDITS - tie.price)
  assert.equal(p.owns('look', SHOP_LOOK_BASE + 24), true, 'the line\'s own bit in the look space')
  assert.equal(p.owns('furniture', SHOP_LOOK_BASE + 24), false, 'and in no other space')
  assert.equal(calls, 1)
  assert.equal(k.buy(24).verdict, GATE.owned)
  assert.equal(k.purse.credits(), STARTING_CREDITS - tie.price, 'never charged twice')
  const worn = k.wear(24, look)
  assert.ok(worn && wearing(worn, tie))
  assert.equal(k.rows('tailor', worn).find((row) => row.item.id === 24)?.worn, true)
  // Refused with the reason, nothing taken: above the level, above the purse, no such line.
  assert.equal(k.buy(5).verdict, GATE.level)
  assert.equal(k.buy(48).verdict, GATE.credits, 'the forearm\'s designs are on sale, above a new operator\'s purse')
  assert.equal(k.buy(133).verdict, GATE.level, 'the headphones are on sale, above a new operator\'s level')
  assert.equal(k.buy(160).verdict, GATE.level, 'furniture is on sale, above a new operator\'s level')
  assert.equal(k.buy(4242).verdict, GATE.unavailable)
  assert.equal(k.purse.credits(), STARTING_CREDITS - tie.price)
  // The gate refuses what is not a purchase.
  for (const [space, index, level, price] of [['look', 1024, 1, 0], ['nowhere', 0, 1, 0], ['look', 0, 0, 0], ['look', 0, 21, 0], ['look', 0, 1, -1], ['look', 0, 1, 0.5]] as const) {
    assert.equal(k.purse.canBuy(space as Space, index, level, price), GATE.unavailable)
    assert.equal(k.purse.buy(space as Space, index, level, price), GATE.unavailable)
  }
  off()
  // Reloaded from the same store: the purchase and the balance are still there.
  const again = createShopkeeper({ purse: progressionPurse(createProgress({ store: s, seed: () => 1, now: () => 0 })) })
  assert.equal(again.owns(24), true)
  assert.equal(again.purse.credits(), STARTING_CREDITS - tie.price)
})

test('the progression keeper sells homes: a new operator claims the Micro-Loft for 0 cr and is told the Brownstone\'s level; at level 3 it is bought', () => {
  const s = memory()
  const k = createShopkeeper({ purse: progressionPurse(createProgress({ store: s, seed: () => 1337, now: () => 0 })) })
  let calls = 0
  k.onChange(() => { calls++ })
  // The design house's card: the free loft for sale, the other six deeds gated by level, and every piece of furniture
  // on sale but above a new operator's level 1 (the bookcase and the sofa ask level 2), each saying which level it needs.
  const rows = k.rows('designHouse', null)
  assert.deepEqual(rows.filter((r) => r.item.kind === 'deed').map((r) => r.verdict),
    [GATE.bought, GATE.level, GATE.level, GATE.level, GATE.level, GATE.level, GATE.level])
  assert.deepEqual(rows.filter((r) => r.item.kind === 'deed').slice(1).map((r) => r.why),
    ['needs level 3', 'needs level 6', 'needs level 10', 'needs level 14', 'needs level 17', 'needs level 20'])
  for (const r of rows.filter((row) => row.item.kind === 'furniture')) {
    assert.equal(r.verdict, GATE.level, r.item.name)
    assert.equal(r.why, `needs level ${r.item.level}`)
    assert.ok(!/on order/.test(r.why))
  }
  assert.ok(rows.every((r) => !r.worn))
  // The free loft is claimed for nothing, and sets property bit 0.
  const loft = k.buy(224)
  assert.equal(loft.verdict, GATE.bought, loft.message)
  assert.equal(k.purse.credits(), STARTING_CREDITS)
  assert.equal(k.owns(224), true)
  assert.equal(k.purse.owns('property', 0), true)
  assert.equal(k.buy(224).verdict, GATE.owned, 'claimed once')
  assert.equal(k.wear(224, LOOK_PRESETS[0].look), null, 'a deed is never worn')
  // The brownstone needs level 3: refused with the level named, nothing taken, nothing set.
  const early = k.buy(225)
  assert.equal(early.verdict, GATE.level)
  assert.match(early.message, /needs level 3/)
  assert.equal(k.purse.credits(), STARTING_CREDITS)
  assert.equal(k.owns(225), false)
  assert.equal(calls, 1)
  // Reloaded, the loft is still owned and the rows say so.
  const again = createShopkeeper({ purse: progressionPurse(createProgress({ store: s, seed: () => 1, now: () => 0 })) })
  assert.deepEqual(again.rows('designHouse', null).filter((r) => r.owned).map((r) => r.item.id), [224])
  // A keeper at level 3 with the credits buys the brownstone: 4,000 cr taken, property bit 1 set.
  const p = fakeProgress(3, 5000)
  const k3 = createShopkeeper({ purse: progressionPurse(p) })
  const brownstone = k3.buy(225)
  assert.equal(brownstone.verdict, GATE.bought, brownstone.message)
  assert.equal(k3.purse.credits(), 1000)
  assert.equal(p.owns('property', 1), true)
  assert.match(k3.buy(226).message, /Pierside Timber Loft: needs level 6/)
})

test('furniture through the same gate: a level 2 keeper with 3,000 cr buys a bookcase and a sofa, sets their bits, and is told the workstation\'s level', () => {
  // The browser smoke's furnishing run takes the same path: the loft claimed, then these two pieces (2,700 cr).
  const p = fakeProgress(2, 3000)
  const k = createShopkeeper({ purse: progressionPurse(p) })
  assert.equal(k.buy(224).verdict, GATE.bought, 'the free loft')
  const bookcase = k.buy(164), sofa = k.buy(163)
  assert.equal(bookcase.verdict, GATE.bought, bookcase.message)
  assert.equal(sofa.verdict, GATE.bought, sofa.message)
  assert.equal(k.purse.credits(), 300)
  assert.deepEqual([p.owns('furniture', 4), p.owns('furniture', 3), k.owns(164), k.owns(163)], [true, true, true, true], 'furniture bit = id - 160')
  assert.equal(k.buy(164).verdict, GATE.owned, 'a line is a licence, bought once for every home')
  assert.match(k.buy(168).message, /Agent workstation: needs level 3/)
  assert.match(k.buy(167).message, /Hydroponic green wall: needs level 4/)
  assert.equal(k.wear(164, LOOK_PRESETS[0].look), null, 'a piece is never worn')
  const rows = k.rows('designHouse', null)
  assert.deepEqual(rows.filter((r) => r.owned).map((r) => r.item.id), [163, 164, 224])
})

/** A stand-in for the progression keeper, by its documented contract (docs/progression.md, the purchase gate): any level, and a refusal on demand. */
function fakeProgress(level: number, balance: number) {
  const record = new Float64Array(32)
  record[PROGRESS_WORD.level] = level
  record[PROGRESS_WORD.credits] = balance
  const owned = new Set<string>()
  const fns = new Set<(check: null) => void>()
  let refuse = false
  const canBuy = (space: Space, index: number, levelReq: number, price: number) =>
    !Object.hasOwn(SPACE_SIZE, space) || index < 0 || index >= SPACE_SIZE[space] ? 4 : owned.has(`${space}:${index}`) ? 1 : record[14] < levelReq ? 2 : record[16] < price ? 3 : 0
  const p: ProgressLike & { refuse(v: boolean): void } = {
    record,
    canBuy,
    buy(space, index, levelReq, price) {
      const r = refuse ? 3 : canBuy(space, index, levelReq, price)
      if (r !== 0) return r
      record[16] -= price
      owned.add(`${space}:${index}`)
      for (const f of fns) f(null)
      return 0
    },
    owns: (space, index) => owned.has(`${space}:${index}`),
    subscribe(fn) { fns.add(fn); return () => { fns.delete(fn) } },
    refuse(v) { refuse = v },
  }
  return p
}

test('a keeper by the documented contract: its level gates, its gate buys, its refusal leaves no bit, its subscribe redraws', () => {
  const p = fakeProgress(20, 10_000)
  const k = createShopkeeper({ purse: progressionPurse(p) })
  assert.equal(k.purse.level(), 20)
  assert.equal(k.purse.credits(), 10_000)
  let calls = 0
  k.onChange(() => { calls++ })
  assert.equal(k.buy(14).verdict, GATE.bought, 'level 6 trim at level 20')
  assert.equal(k.purse.credits(), 10_000 - itemById(14)!.price)
  assert.equal(p.owns('look', SHOP_LOOK_BASE + 14), true)
  assert.equal(k.owns(14), true)
  assert.equal(calls, 1)
  assert.equal(k.buy(14).verdict, GATE.owned)
  p.refuse(true)
  assert.ok(itemById(16) && onSale(itemById(16)!), 'a line on sale, so the refusal is the keeper\'s')
  assert.equal(k.buy(16).verdict, GATE.credits, 'the keeper refused')
  assert.equal(k.owns(16), false, 'no bit without the credits taken')
  assert.equal(p.owns('look', SHOP_LOOK_BASE + 16), false)
  // A low level and an empty purse: the rows say why, and nothing changes.
  const poor = createShopkeeper({ purse: progressionPurse(fakeProgress(1, 150)) })
  const rows = poor.rows('tailor', LOOK_PRESETS[0].look)
  assert.equal(rows.find((r) => r.item.id === 5)!.verdict, GATE.level)
  assert.equal(rows.find((r) => r.item.id === 0)!.verdict, GATE.credits)
  assert.match(rows.find((r) => r.item.id === 0)!.why, /250 more credits/)
  assert.equal(rows.find((r) => r.item.id === 24)!.verdict, GATE.bought, 'a 120-credit tie on a new operator\'s 150')
})
